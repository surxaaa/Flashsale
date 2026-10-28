# flash-sale

Checkout for a 500-unit flash sale that has to survive a big burst of traffic without overselling.

Stack: Fastify (TypeScript) API, RabbitMQ, a worker that writes to Postgres, Redis for the inventory counter, a Next.js sale page, NGINX in front, all on Docker Compose. k6 for load testing.

The reasoning behind the design (locking strategies, polling vs WebSockets, why Redis Lua, what changes in production) is in [DESIGN.md](DESIGN.md).

## How it works

- `POST /checkout` never touches Postgres. A Redis Lua script checks that the user hasn't bought yet and that stock is above zero, then decrements and records the user in one step. If that passes, the order goes onto RabbitMQ and the API returns `202` with a polling URL.
- The worker inserts the order (unique on order id, so a redelivered message does nothing) and runs `UPDATE inventory SET stock = stock - 1 WHERE stock > 0` in the same transaction. It acks only after commit.
- If anything fails before commit, the Redis unit is released. Release only happens if the user is still in the buyers set, so it can't run twice for the same order.
- Orders sit in `PENDING_PAYMENT` until the mock pay call. After 2 minutes unpaid they expire and the unit goes back to both Postgres and Redis.
- The sale opens at a set time. The page counts down to it, and 45 s before the start it logs in and solves the proof-of-work in the background, so the click itself only sends the checkout.
- Bots: NGINX rate limits `/api/checkout` per IP, the API rate limits per user, and checkout needs a JWT plus a solved proof-of-work challenge.

```
apps/api         Fastify API
apps/worker      RabbitMQ consumer + expiry job
apps/web         Next.js sale page
packages/shared  keys, queue name, Lua scripts
infra/           schema, nginx config
loadtest/        k6 script
scripts/         reset.sh, verify.sh
```

## Running it

Needs Docker, Node 20 and pnpm. k6 is optional, since it can run from Docker.

```bash
pnpm install
docker compose build
docker compose up -d --wait
./scripts/reset.sh
```

Open http://localhost:8080 for the sale page. The RabbitMQ UI is on http://localhost:15672 (guest/guest).

`./scripts/reset.sh` puts everything back to 500 units and opens the sale immediately. `./scripts/reset.sh 60` opens it in 60 seconds instead, which is the way to see the countdown and the early login/PoW. `./scripts/verify.sh` prints Postgres and Redis counts so you can check they agree.

Replica counts live in the compose file (3 API, 2 workers) and can be changed with `API_REPLICAS` / `WORKER_REPLICAS`. Passing `--scale` on the command line also works, but a later `docker compose up nginx` resets dependencies back to the default scale, which is why they're set in the file. If NGINX was started before the API replicas existed, `docker compose restart nginx` makes it pick them all up.

## Load test

k6 runs from a single IP and can't solve PoW cheaply, so turn both off for the test:

```bash
POW_ENABLED=false CHECKOUT_RATE=100000r/s CHECKOUT_BURST=100000 \
  docker compose up -d --wait --force-recreate api nginx
./scripts/reset.sh
docker run --rm --network flash-sale_default --ulimit nofile=65535:65535 \
  -v "$PWD/loadtest:/scripts:ro" grafana/k6:0.54.0 \
  run -e BASE=http://nginx -e VUS=10000 /scripts/checkout.js
./scripts/verify.sh
```

Run k6 inside the Docker network like this rather than against `localhost:8080`. On macOS, Docker Desktop's port forwarding resets 0–15% of new connections under a burst, at any user count. That's the laptop, not the app, and it hides the real numbers. `k6 run -e VUS=3000 loadtest/checkout.js` from the host still works for smaller runs.

What should come out: `accepted_202` = 500, 500 active orders, stock 0 in both Postgres and Redis, 500 buyers, no duplicate users, empty queue, no failed requests.

Give the API a few seconds after recreating it before starting k6. The first run straight after a restart had about 4% failed logins while the replicas warmed up.

For the crash test, the workers drain 500 messages in well under a second, so killing them while k6 runs usually misses. What worked better: `docker compose stop worker`, run k6 so all 500 orders pile up in the queue, `docker compose start worker`, then `docker compose kill worker` a fraction of a second later, `docker compose up -d worker`, and verify once it drains. Counts should still be exactly 500.

Afterwards, `docker compose up -d --force-recreate api nginx` (without the env vars) puts PoW and the 5 r/s gateway limit back.

## Results

Run on an Apple Silicon Mac, Docker Desktop with 10 CPUs and 8 GB, 3 API replicas and 2 workers. k6 runs as a container on the same machine, inside the Docker network.

| Users (one burst) | Requests | Throughput | Median / p95 latency | Dropped | 202s | Orders in DB | DB / Redis stock | Duplicate users |
|---|---|---|---|---|---|---|---|---|
| 3,000 | 6,000 | ~4,300 req/s | 96 ms / 1.15 s | 0% | 500 | 500 | 0 / 0 | 0 |
| 5,000 | 10,000 | ~5,300 req/s | 128 ms / 1.55 s | 0% | 500 | 500 | 0 / 0 | 0 |
| 10,000 | 20,000 | ~6,600–7,200 req/s | 200–325 ms / 2.1–2.3 s | 0% | 500 | 500 | 0 / 0 | 0 |
| 20,000 | 40,000 | ~4,500 req/s | 960 ms / 4.9 s | 0% | 500 | 500 | 0 / 0 | 0 |

- **0% dropped up to a 20,000-user burst** (40,000 requests in 8.9 s). Latency climbs past 10,000 users because k6, NGINX, three API replicas, Redis, RabbitMQ and Postgres all share 10 CPUs. 100k concurrent users needs distributed load generators and real hardware.
- **NGINX was the bottleneck at first.** Stock NGINX allows 1024 connections per worker, and each proxied request uses two. Before tuning, 10,000 users meant 34% of requests dropped with `EOF` / connection reset, and NGINX logged `worker_connections are not enough`. `infra/nginx/nginx.conf` raises the connection limit, open files and listen backlog.
- **Exactly 500 sold in every run.** Over twenty burst runs in total. Postgres never had more than 500 active orders, stock never went below 0, and no user got two.
- In one early 10,000-user run, k6 counted 501 accepted checkouts and one 5xx. The worker's `stock > 0` update rejected the extra order and marked it `SOLD_OUT`, so 500 were still sold. The root cause isn't pinned down. It hasn't come back in any later run, and API error logging is now on so it can be traced if it does.
- **Worker crash:** 500 orders queued, workers killed mid-drain with 343 in the DB and 158 still queued (343 + 158 = 501, so at least one message was committed but not acked). After restart: 500 orders, stock 0/0, no duplicates. The redelivered message hit the `ON CONFLICT` path and was a no-op.
- **Payment expiry:** an unpaid order expired after about 2 minutes. DB stock and Redis stock both went back to 500, and the buyer was cleared.
- **Gateway rate limit:** 60 back-to-back requests from one IP gave 22 through (burst 20 plus refill) and 38 `429`s.
- **Proof-of-work:** checkout with a valid JWT but no PoW returns `403 pow_failed`. Checkout before the start time returns `409 NOT_OPEN`.
- **Sale status polling:** NGINX caches `/api/sale/status` for 1 s (`X-Cache: HIT`), so polling tabs barely reach the API.
- **Frontend (Lighthouse 12):**

  | Profile | Score | TTI | FCP | Total blocking time | JS transferred |
  |---|---|---|---|---|---|
  | Desktop | 100 | 0.4 s | 0.2 s | 0 ms | 105 KiB |
  | Mobile (slow 4G, 4× CPU slowdown) | 97 | 1.9 s | 0.6 s | 180 ms | 105 KiB |

  The 200 KB budget is met with room to spare. The TTI target is met on desktop and missed by 0.4 s on Lighthouse's throttled mobile profile. Almost all of the 105 KiB is the React/Next runtime (the page itself is about 2 KiB), so the options are Brotli at the CDN, Preact, or plain JS for this page. DESIGN.md has more.
