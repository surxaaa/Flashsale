# Flash Sale Checkout

A checkout service for a festival flash sale that sells exactly 500 phones to a burst of concurrent buyers without overselling. Built with Node.js (TypeScript, Fastify), Redis, RabbitMQ, PostgreSQL, Next.js and NGINX, all running on Docker Compose.

**Role:** Full-Stack Software Engineer (campus placement case study)

## Summary

The brief: 500 phones go on sale at 8:00 PM, and more than 100,000 checkout requests arrive in the first ten seconds. Earlier trial runs had high latency, database row locks and request timeouts, and confirmed 540 orders for 500 phones.

My approach takes the database off the request path. A Lua script running inside Redis decides who gets a phone in one atomic step. The API replies `202 Accepted` straight away, and background workers save the winning orders to PostgreSQL through a RabbitMQ queue. PostgreSQL checks the stock again on every write, so it never confirms more than 500 even if Redis gets something wrong.

| Result (one Mac, Docker Desktop, 10 CPUs) | Trial run (from the brief) | This project |
|---|---|---|
| Orders confirmed against 500 units | 540 | **500 in every run** |
| Largest burst tested | not stated | 20,000 users, 40,000 requests in 8.9 s |
| Dropped requests | timeouts | **0%** up to 20,000 users |
| Throughput at 10,000 users | not stated | 6,200–7,200 requests/s |
| 95th percentile response time at 10,000 users | not stated | 2.1–2.5 s (load generator on the same machine) |
| Workers killed mid-sale | not tested | 500 confirmed, no duplicates |
| JavaScript sent to the browser | not stated | 105 KiB (budget 200 KB) |

The 100,000-request peak has **not** been demonstrated on real hardware. See [Performance](#performance-and-scalability).

## Contents

1. [The problem](#the-problem)
2. [What went wrong and how it was fixed](#what-went-wrong-and-how-it-was-fixed)
3. [Features](#features)
4. [Architecture](#architecture)
5. [Checkout flow](#checkout-flow)
6. [Technology stack](#technology-stack)
7. [Repository structure](#repository-structure)
8. [Getting started](#getting-started)
9. [Configuration](#configuration)
10. [API](#api)
11. [How overselling is prevented](#how-overselling-is-prevented)
12. [Error handling and reliability](#error-handling-and-reliability)
13. [Testing](#testing)
14. [Performance and scalability](#performance-and-scalability)
15. [Design decisions](#design-decisions)
16. [Limitations and future work](#limitations-and-future-work)
17. [Screenshots](#screenshots)

## The problem

The original checkout did three things wrong:

- **Check-then-act race.** It read the stock in one query and wrote it back in another. Two requests could both read "1 left" and both succeed, which is how 540 orders happened.

  ```
  Request A: SELECT stock -> 1
  Request B: SELECT stock -> 1
  Request A: UPDATE stock = 0      sold
  Request B: UPDATE stock = 0      sold again
  ```

- **Hot-row locking.** Every request updated the same inventory row. PostgreSQL lets only one transaction write a row at a time, so 100,000 requests queued on one lock, each holding a pool connection while it waited. The pool ran out and requests timed out.
- **Database work inside the request (N+1 round trips).** Each checkout made several queries before replying, so users waited on the slowest part of the system.

Only 500 of those requests can ever succeed, so the database should only ever see 500 writes.

## What went wrong and how it was fixed

### Problems from the case study

| Problem in the trial run | Cause | What this project does | Proof |
|---|---|---|---|
| 540 orders for 500 phones | Read stock, then write stock, in two separate steps | One Redis Lua script checks and decrements atomically. PostgreSQL re-checks with `UPDATE … WHERE stock > 0` and a `CHECK (stock >= 0)` constraint. | 500 orders in every one of 20+ load runs |
| Database row locks | 100,000 transactions writing one inventory row | Checkout never touches PostgreSQL. Only the 500 winners are written, by background workers. | 9,500 of 10,000 users answered "sold out" by Redis alone |
| API timeouts | The request waited for the database write | API replies `202 Accepted` with a tracking URL once the order is queued | 0% failed requests up to 20,000 users |
| Repeated clicks spamming the API | No client-side guard | Button locks on the first click (synchronous `useRef` flag). One order per user enforced in Redis and in PostgreSQL. | Second click shows "You already have one" |
| Bot traffic | No gateway protection | NGINX per-IP rate limit, JWT, single-use proof-of-work, per-user rate limit | 38 of 60 rapid requests got `429`; checkout without proof-of-work gets `403` |
| UI freezing while waiting | Blocking request, no queue states | Instant "You're in line…" state, then polling with backoff and jitter until the order settles | Every state shown on the page (see screenshots) |
| Load not shared safely across servers | Stateful servers | Stateless API replicas behind NGINX `least_conn`. All shared state lives in Redis. | 3 API replicas under load |

### Problems found while building it

| What went wrong | How it showed up | Fix |
|---|---|---|
| NGINX's default `worker_connections 1024` | At 10,000 users, 34% of requests dropped (`EOF`, connection reset). NGINX logged "worker_connections are not enough". | `infra/nginx/nginx.conf`: 16,384 connections, open-file limit 65,535, listen backlog 4,096. Result: 0% dropped at 10,000 and 20,000 users. |
| Starting NGINX scaled the API back to one replica | `docker compose up nginx` re-applied the default scale to its dependencies | Replica counts set in `docker-compose.yml` (`API_REPLICAS`, `WORKER_REPLICAS`) |
| Docker Desktop port forwarding on macOS | 0–15% random connection resets at any load, before requests reached NGINX | Load tests run k6 inside the Docker network, pointed straight at NGINX |
| A redelivered message left the order stuck at `QUEUED` | Worker crashed after commit but before writing the Redis status | On a duplicate insert, the worker copies the real status from PostgreSQL back to Redis |
| A malformed message could never be acknowledged | `JSON.parse` failed outside the error handler | Messages are validated; bad ones are logged and dropped, since there is no dead-letter queue to send them to |
| API errors left no trace | Fastify's logger was off by default | Warn-level logging on (`LOG_LEVEL`) |
| One early 10,000-user run accepted 501 checkouts | k6 counted 501 `202`s and one 5xx | The worker's `stock > 0` check rejected the extra order and marked it `SOLD_OUT`, so 500 were still sold. The cause wasn't found because logging was off at the time; it hasn't recurred in 20+ runs since. |
| Click-time latency | Login and the proof-of-work ran only after the click | The page logs in and solves the proof-of-work 45 s before the sale; the click sends only the checkout |
| Every open tab polling the API | 100,000 tabs × one status request every 3 s | NGINX caches `/api/sale/status` for 1 second, so the API sees about one request per second |

## Features

**Implemented**

- Sale page with a countdown to the start time, a button that locks on the first click, and clear states: waiting, in line, reserved, confirmed, sold out, already purchased, expired, failed
- Login and proof-of-work solved before the sale opens, so the click sends one request
- Atomic reservation in Redis: stock check, decrement and one-per-customer in a single Lua script
- Asynchronous persistence: API → RabbitMQ (durable queue, persistent messages) → workers → PostgreSQL
- Conditional SQL update (`WHERE stock > 0`), `CHECK (stock >= 0)`, and a unique index for one active order per user, as a database-level safety net
- Idempotent workers: the order ID is the primary key, and a redelivered message does nothing
- Mock payment step; unpaid reservations expire after 2 minutes and the unit returns to stock
- Order status tracking through `GET /api/orders/{id}`, with polling backoff (500 ms → 3 s) and jitter
- NGINX load balancing (`least_conn`) across 3 API replicas, per-IP rate limiting, 1-year static asset cache and a 1-second sale-status cache
- Bot protection: JWT, single-use SHA-256 proof-of-work, per-user rate limit in Redis
- k6 load test, worker crash test, and `reset.sh` / `verify.sh` scripts for repeatable runs and manual reconciliation

**Designed but not implemented**

- CDN (CloudFront), AWS load balancer with scheduled scaling before the sale, AWS WAF and a real CAPTCHA
- RabbitMQ publisher confirms, a dead-letter queue, and an automated Redis/PostgreSQL reconciliation job
- Real user accounts (login is mocked)

## Architecture

This is what runs locally with `docker compose up`:

```mermaid
flowchart TB
    B["Browser<br/>Next.js sale page<br/>button lock · countdown · polling"]
    N["NGINX<br/>per-IP rate limit · least_conn<br/>static cache 1 year · status cache 1 s"]
    A["API x3 (Fastify, stateless)<br/>JWT · proof-of-work · per-user limit"]
    R[("Redis<br/>sale:stock · sale:buyers<br/>order status")]
    Q[["RabbitMQ<br/>durable queue: orders"]]
    W["Workers x2<br/>prefetch 20 · payment expiry job"]
    P[("PostgreSQL<br/>inventory · orders")]

    B -- "POST /api/checkout → 202" --> N
    B -. "GET /api/orders/:id (poll)" .-> N
    N --> A
    A -- "one Lua script" --> R
    A -- "publish {orderId, userId}" --> Q
    Q --> W
    W -- "one transaction per order" --> P
    W -- "status / release token" --> R
    A -. "mock pay (low volume)" .-> P
```

| Component | What it does |
|---|---|
| Sale page (`apps/web`) | Next.js page. Counts down to the sale, logs in and solves the proof-of-work early, locks the button, polls for the result |
| NGINX (`infra/nginx`) | Rate-limits each IP on checkout (5 per second, burst 20), balances across API replicas, caches static files and sale status |
| API (`apps/api`) | Stateless Fastify server. Checks the JWT, proof-of-work and per-user limit, runs the reservation script, publishes the order, replies `202` |
| Redis | Holds the stock counter, the buyer set, order statuses, proof-of-work challenges and rate-limit counters |
| RabbitMQ | Durable queue between the API and the database |
| Workers (`apps/worker`) | Save each order in one PostgreSQL transaction, update its status in Redis, expire unpaid orders |
| PostgreSQL | Source of truth for stock and orders |

## Checkout flow

1. **Before the sale**, the page shows a countdown. 45 seconds before the start, it logs in and solves a proof-of-work challenge in the background.
2. **The user clicks Buy now.** The button locks immediately and the page shows "You're in line…".
3. **NGINX** checks the per-IP rate limit, then forwards the request to the least busy API replica.
4. **The API** checks the JWT, the single-use proof-of-work, the per-user rate limit and that the sale has started.
5. **The API runs the reservation Lua script in Redis.** In one atomic step it rejects users who already have a phone, returns sold out if stock is 0, and otherwise decrements stock and records the buyer.
6. **The API saves status `QUEUED`, publishes the order to RabbitMQ, and replies `202 Accepted`** with the order ID and a tracking URL. No database call has happened yet.
7. **A worker runs one transaction:** insert the order (skipped if it already exists), then `UPDATE inventory SET stock = stock - 1 WHERE stock > 0`, then commit. It sets the status to `PENDING_PAYMENT` and acknowledges the message.
8. **The page polls the tracking URL** (500 ms growing to 3 s, plus jitter) until it shows **Reserved**, **Sold out** or **Failed**.
9. **The user pays (mock)** and the order becomes **Confirmed**. If nobody pays within 2 minutes, the order expires and the phone goes back on sale.

## Technology stack

| Technology | Used for | Why I chose it |
|---|---|---|
| Node.js 20 + TypeScript + Fastify | API and workers | Checkout is almost entirely waiting on Redis and RabbitMQ, which suits a non-blocking event loop. Nothing CPU-heavy runs on it. |
| Redis 7 (Lua) | Stock token, buyer set, order status, rate limits | Runs a multi-step script atomically in microseconds without locks. A plain `DECR` can't enforce "only if above zero" or "one per customer". |
| RabbitMQ 3 | Queue between API and database | A work queue: each order handled once by one worker, acknowledged after commit, redelivered on a crash. Kafka's replayable log is more than 500 orders need. |
| PostgreSQL 16 | Orders and inventory | ACID transactions and constraints give a final guarantee that doesn't depend on Redis being right |
| Next.js 15 + React 19 | Sale page | Production build with no UI libraries. 105 KiB of JS, and the page code itself is about 2 KiB. |
| NGINX 1.27 | Load balancing, rate limiting, caching | Stands in for a cloud load balancer and CDN locally |
| Docker Compose | Running everything | One command starts all services, with replica counts in the file |
| pnpm workspaces | Monorepo | API, worker and web share one package for keys, queue name and Lua scripts |
| Grafana k6 | Load tests | Scripts thousands of concurrent users and reports percentiles |

## Repository structure

```
flash-sale/
├── apps/
│   ├── api/src/index.ts        API: login, proof-of-work, sale status, checkout, order status, pay
│   ├── worker/src/index.ts     RabbitMQ consumer and payment expiry job
│   └── web/app/page.tsx        Sale page
├── packages/
│   └── shared/src/index.ts     Redis keys, queue name, reserve and release Lua scripts
├── infra/
│   ├── db/init.sql             Tables, constraints and starting stock
│   └── nginx/
│       ├── nginx.conf          Connection limits
│       └── default.conf.template   Load balancer, rate limit, caching
├── loadtest/checkout.js        k6 burst test
├── scripts/
│   ├── reset.sh                Reset stock to 500 and schedule the sale
│   └── verify.sh               Compare PostgreSQL and Redis counts
├── docs/screenshots/
├── Dockerfile                  One image for every app, chosen by build argument
├── docker-compose.yml
├── package.json
├── pnpm-workspace.yaml
└── pnpm-lock.yaml
```

## Getting started

### Prerequisites

- **Docker Desktop** with Docker Compose v2 (tested on macOS)
- About 2 GB of free disk space for the images
- Node.js is **not** needed to run it; dependencies are installed inside the images. Node 20 and pnpm are only needed to run type checks locally.
- **k6** is optional; the load test can run from the `grafana/k6` Docker image

### Run it

```bash
git clone https://github.com/surxaaa/Flashsale.git
cd Flashsale
docker compose up -d --build --wait
./scripts/reset.sh 30
```

`reset.sh` sets stock to 500 and schedules the sale. The number is the delay in seconds before it opens (`0` opens it immediately). Until it's run once, the page shows "Sale not scheduled yet". PostgreSQL creates its tables from `infra/db/init.sql` on first start.

| Page | URL |
|---|---|
| Sale page | http://localhost:8080 |
| RabbitMQ dashboard | http://localhost:15672 (guest / guest) |

Check the counts at any time:

```bash
./scripts/verify.sh
```

To stop:

```bash
docker compose down
```

## Configuration

`docker-compose.yml` already sets working local values, so nothing needs configuring to run the project.

| Variable | Used by | Purpose | Local value |
|---|---|---|---|
| `REDIS_URL` | API, worker | Redis connection | `redis://redis:6379` |
| `AMQP_URL` | API, worker | RabbitMQ connection | `amqp://guest:guest@rabbitmq:5672` |
| `DATABASE_URL` | API, worker | PostgreSQL connection | `postgres://flash:flash@postgres:5432/flash` |
| `JWT_SECRET` | API | Signs login tokens | `dev-secret-change-me` |
| `POW_ENABLED` | API | Require proof-of-work on checkout | `true` |
| `LOG_LEVEL` | API | Fastify log level | `warn` |
| `CHECKOUT_RATE` | NGINX | Per-IP checkout rate | `5r/s` |
| `CHECKOUT_BURST` | NGINX | Burst allowance above that rate | `20` |
| `API_REPLICAS` | Compose | Number of API containers | `3` |
| `WORKER_REPLICAS` | Compose | Number of worker containers | `2` |

These values are for local development only. Change `JWT_SECRET` and the database password before deploying anywhere public.

## API

All routes are served through NGINX under `/api`.

| Method | Endpoint | Purpose | Responses |
|---|---|---|---|
| `POST` | `/api/auth/login` | Mock login, body `{ "userId": "..." }` | `200` with a JWT · `400` missing user ID |
| `GET` | `/api/pow/challenge` | Single-use proof-of-work challenge, valid 60 s | `200` with `challenge` and `difficulty` |
| `GET` | `/api/sale/status` | Whether the sale is open, start time, stock left, server time | `200` (cached 1 s by NGINX) |
| `POST` | `/api/checkout` | Reserve a phone. Needs `Authorization: Bearer`, `X-Pow-Challenge`, `X-Pow-Nonce` | `202` reserved · `401` no or bad token · `403` proof-of-work failed · `429` rate limited · `409` `NOT_OPEN` or `ALREADY_PURCHASED` · `410` `SOLD_OUT` · `503` couldn't queue, try again |
| `GET` | `/api/orders/{id}` | Order status (own orders only) | `200` with `QUEUED`, `PENDING_PAYMENT`, `CONFIRMED`, `SOLD_OUT`, `FAILED` or `EXPIRED` · `401` · `404` |
| `POST` | `/api/orders/{id}/pay` | Mock payment | `200` `CONFIRMED` · `409` not payable (expired or already paid) · `401` |

Example checkout:

```http
POST /api/checkout
Authorization: Bearer eyJhbGciOi...
X-Pow-Challenge: 9f2c41d07a3b55e1
X-Pow-Nonce: 52
```

```http
HTTP/1.1 202 Accepted

{ "orderId": "d2d9a8e1-0dd2-41b7-8a81-84be3e1ca84d",
  "pollUrl": "/api/orders/d2d9a8e1-0dd2-41b7-8a81-84be3e1ca84d" }
```

`202` means the phone is **reserved** and the order is **queued**, not that it's saved. The order becomes `PENDING_PAYMENT` once a worker commits it to PostgreSQL (well under a second in testing), and `CONFIRMED` after payment.

## How overselling is prevented

Three guards, each enough on its own to stop overselling:

| Guard | Where | What it stops |
|---|---|---|
| Reservation script | Redis Lua | Two requests taking the same unit; stock going below zero; a user buying twice |
| Conditional update | PostgreSQL worker transaction | More than 500 orders being saved, even if Redis over-reserved |
| Constraints | PostgreSQL schema | `CHECK (stock >= 0)`: negative stock from any code path. Unique index on active `(user_id, product_id)`: a second active order per user. |

**Reservation** (`packages/shared/src/index.ts`). Redis runs a script from start to finish before any other command, so no other request can read the stock between the check and the decrement:

```lua
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return -1 end   -- already bought
local s = tonumber(redis.call('GET', KEYS[1]) or '0')
if s <= 0 then return 0 end                                             -- sold out
redis.call('DECR', KEYS[1])
redis.call('SADD', KEYS[2], ARGV[1])
return 1                                                                -- reserved
```

Giving a unit back uses a second script that only increments stock if the user was actually removed from the buyer set, so a unit can never be released twice.

**Persistence** (`apps/worker/src/index.ts`). The worker saves each order in one transaction and acknowledges the message only after it commits:

```sql
BEGIN;
INSERT INTO orders (id, user_id, product_id, status)
VALUES ($1, $2, $3, 'PENDING_PAYMENT') ON CONFLICT (id) DO NOTHING;  -- 0 rows: duplicate delivery, stop
UPDATE inventory SET stock = stock - 1
 WHERE product_id = $1 AND stock > 0;                               -- 0 rows: SOLD_OUT, release token
COMMIT;
```

**Why the database guarantee holds even if Redis is wrong.** `inventory.stock` starts at 500 and can't go below 0. A conditional `UPDATE` re-checks `stock > 0` against the latest committed value after waiting for any concurrent writer, so two workers can't both take the last unit. PostgreSQL alone never saves more than 500 orders. This happened once in testing: Redis let through a 501st checkout, and the worker marked it `SOLD_OUT`.

**Why not database locks?** `SELECT … FOR UPDATE` is correct, but makes all 100,000 requests wait in line for one row lock. Optimistic version checks are also correct, but almost every attempt conflicts and retries. Both bring back the original latency problem. The Lua script has no gap between reading and writing, and takes no locks.

## Error handling and reliability

| Situation | What happens |
|---|---|
| Double click | Ignored by the button lock |
| Same user in two tabs | Second checkout gets `409 ALREADY_PURCHASED` |
| Too many requests from one IP | `429` from NGINX |
| Too many attempts from one user | `429` from the API (5 per 10 s) |
| Missing or reused proof-of-work | `403` |
| Checkout before the start time | `409 NOT_OPEN` |
| Publishing to RabbitMQ fails | Redis token released, `503`, the user can retry |
| Worker crashes before commit | Transaction rolls back; RabbitMQ redelivers the message |
| Worker crashes after commit, before acknowledging | Redelivered message hits `ON CONFLICT` and is skipped; status re-synced from PostgreSQL |
| PostgreSQL has no stock left | Order marked `SOLD_OUT`, Redis token released |
| PostgreSQL error | Order marked `FAILED`, token released, the user can try again |
| Malformed queue message | Logged and dropped |
| Unpaid for 2 minutes | Order `EXPIRED`, PostgreSQL stock +1, Redis token released |
| Two workers run the expiry job at once | Row locks mean each order is expired once |

## Testing

Testing uses **Grafana k6** load scripts, scripted crash and protection checks, and **Chrome Lighthouse**. There are no unit tests yet.

**Load test.** Proof-of-work and the per-IP limit are switched off because k6 sends everything from one IP and can't solve proof-of-work cheaply:

```bash
POW_ENABLED=false CHECKOUT_RATE=100000r/s CHECKOUT_BURST=100000 \
  docker compose up -d --wait --force-recreate api nginx
./scripts/reset.sh
docker run --rm --network flash-sale_default --ulimit nofile=65535:65535 \
  -v "$PWD/loadtest:/scripts:ro" grafana/k6:0.54.0 \
  run -e BASE=http://nginx -e VUS=10000 /scripts/checkout.js
./scripts/verify.sh
```

Each virtual user logs in once and tries to buy once. A run passes when `accepted_202` is 500, `verify.sh` shows 500 active orders, stock 0 in PostgreSQL and Redis, 500 buyers, no duplicate users and an empty queue, and no requests failed.

**Worker crash test** (with the same load-test settings). Stop the workers so all 500 orders pile up in the queue, start them, kill them a fraction of a second later, then bring them back:

```bash
docker compose stop worker
./scripts/reset.sh
docker run --rm --network flash-sale_default --ulimit nofile=65535:65535 \
  -v "$PWD/loadtest:/scripts:ro" grafana/k6:0.54.0 \
  run -e BASE=http://nginx -e VUS=3000 /scripts/checkout.js
docker compose start worker; sleep 0.4; docker compose kill worker
docker compose up -d worker
./scripts/verify.sh
```

When you're done, put the protections back:

```bash
docker compose up -d --force-recreate api nginx
```

**Results**

| Test | Outcome |
|---|---|
| 3,000 users, 6,000 requests | 500 sold, 0% failed, ~4,300 req/s, p95 1.15 s |
| 5,000 users, 10,000 requests | 500 sold, 0% failed, ~5,300 req/s, p95 1.55 s |
| 10,000 users, 20,000 requests | 500 sold, 9,500 sold out, 0% failed, 6,200–7,200 req/s, p95 2.1–2.5 s |
| 20,000 users, 40,000 requests | 500 sold, 0% failed, 8.9 s total, p95 4.9 s |
| Worker crash | Killed with 343 orders saved and 158 still queued (one committed but not acknowledged). After restart: 500 orders, no duplicates. |
| Payment expiry | Unpaid order expired after about 2 minutes; stock back to 500 in PostgreSQL and Redis |
| 60 rapid requests from one IP | 22 through (burst plus refill), 38 got `429` |
| Checkout without proof-of-work | `403 pow_failed` |
| Checkout before the start time | `409 NOT_OPEN` |
| Lighthouse, desktop | Performance 100, Accessibility 100, Best Practices 96, SEO 100 |
| Lighthouse, mobile | Performance 99, Accessibility 100, Best Practices 96, SEO 100 |

## Performance and scalability

| Objective | How it is measured | Target | Result |
|---|---|---|---|
| No more than 500 orders | Final database count | ≤ 500 | 500 in every run |
| No dropped requests | k6 `http_req_failed` | 0% | 0% up to 20,000 users |
| Peak load | k6 requests per second | ~10,000 req/s | **Up to ~7,200 req/s on one laptop; not yet demonstrated** |
| Checkout never waits on the database | Code path | No DB call on `/checkout` | Two Redis calls and one publish |
| Bundle size | Lighthouse JS transferred | < 200 KB | 105 KiB |
| Time to interactive | Lighthouse | < 1.5 s | **0.4 s desktop**; 1.8 s on Lighthouse's throttled mobile profile |

The laptop ran k6 and every service at once on 10 CPUs. Latency climbs above 10,000 users because they compete for the same CPU, not because requests fail. The API holds no state, so capacity grows by adding replicas, and each checkout is one Lua call in Redis. A single Redis instance handles roughly 100,000 simple operations per second, and PostgreSQL only ever sees 500 writes. Reaching 100,000 users needs distributed load generators, a cloud load balancer, a CDN in front, and more API replicas started before 8 PM.

On mobile TTI: almost all of the 105 KiB is the React/Next.js runtime, and the page code is about 2 KiB. Brotli compression at a CDN, Preact, or rewriting this one page in plain JavaScript would bring it under 1.5 s.

## Design decisions

- **Decide in Redis, persist asynchronously.** Writing every order synchronously would bring back the hot-row bottleneck. Redis gives every user an answer in milliseconds; the database only sees the 500 winners.
- **Lua script rather than row locks.** It has no gap between reading and writing, and holds no locks.
- **Two independent guards.** Redis is the fast gate; PostgreSQL's conditional update and constraints are the record and the safety net. One guard catches the other's mistakes.
- **RabbitMQ, acknowledged after commit.** At-least-once delivery plus an idempotent worker (order ID as primary key) means each order is saved exactly once, even when a worker crashes.
- **Polling, not WebSockets.** Each user needs one result. Polling is stateless, passes through NGINX and a CDN, and with backoff and jitter costs very little. WebSockets would mean 100,000 stateful connections for one message each.
- **Lock the button on the first click, don't debounce it.** A debounce delays the first click, which is the one that matters in a race.
- **Never optimistic about success.** "You're in line" shows instantly, but "Reserved" and "Confirmed" only appear once the server says so.
- **Bot protection in layers, cheapest first.** NGINX rejects floods before they cost any Node CPU, then JWT, proof-of-work and the per-user limit.

## Limitations and future work

- 100,000 concurrent users hasn't been demonstrated; a distributed load test on real hardware is needed.
- Mobile time to interactive is 1.8 s against the 1.5 s target (desktop is 0.4 s).
- No RabbitMQ publisher confirms, so a message could be lost if the broker dies right after a `202`.
- No dead-letter queue and no automated reconciliation between Redis and PostgreSQL; `verify.sh` is run by hand.
- Login is mocked, and bot protection is proof-of-work rather than a real CAPTCHA.
- The order ID is kept only in page state, so refreshing during a purchase loses the tracking link (the user still can't buy twice).
- Single Redis instance; production would use a replicated, managed Redis.
- No unit tests; testing is load-based.

## Screenshots

**Countdown before the sale opens**

![Countdown](docs/screenshots/countdown.png)

**Reserved, waiting for payment**

![Reserved](docs/screenshots/reserved.png)

**Second attempt by the same user**

![Already purchased](docs/screenshots/already-purchased.png)

**k6: 10,000 users, 20,000 requests, 0% failed, exactly 500 accepted**

![k6 result](docs/screenshots/k6-10000-users.png)

**verify.sh after that run: PostgreSQL and Redis agree**

![verify.sh](docs/screenshots/verify.png)

**Rate limiting (429), proof-of-work (403) and early checkout (409)**

![Protection checks](docs/screenshots/protection.png)

**Lighthouse, desktop**

![Lighthouse desktop](docs/screenshots/lighthouse-desktop.png)

**Lighthouse, mobile**

![Lighthouse mobile](docs/screenshots/lighthouse-mobile.png)
