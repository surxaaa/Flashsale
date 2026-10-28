import Fastify, { FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import amqp from "amqplib";
import jwt from "jsonwebtoken";
import pg from "pg";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { KEYS, QUEUE, PRODUCT_ID, POW_DIFFICULTY, RESERVE_LUA, RELEASE_LUA } from "@flash/shared";

const SECRET = process.env.JWT_SECRET!;
const POW_ENABLED = process.env.POW_ENABLED !== "false";

const redis = new Redis(process.env.REDIS_URL!);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const conn = await amqp.connect(process.env.AMQP_URL!);
const channel = await conn.createChannel();
await channel.assertQueue(QUEUE, { durable: true });

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? "warn" } });

type IdParams = { Params: { id: string } };

function authUser(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  try {
    return (jwt.verify(h.slice(7), SECRET) as { sub: string }).sub;
  } catch {
    return null;
  }
}

// mock login, any userId gets a token
app.post("/auth/login", async (req, reply) => {
  const { userId } = (req.body ?? {}) as { userId?: string };
  if (!userId) return reply.code(400).send({ error: "userId required" });
  return { token: jwt.sign({ sub: userId }, SECRET, { expiresIn: "1h" }) };
});

// single use, valid for 60s
app.get("/pow/challenge", async () => {
  const challenge = randomBytes(8).toString("hex");
  await redis.set(`pow:${challenge}`, "1", "EX", 60);
  return { challenge, difficulty: POW_DIFFICULTY };
});

async function powValid(challenge?: string, nonce?: string) {
  if (!challenge || nonce === undefined) return false;
  const existed = await redis.getdel(`pow:${challenge}`);
  if (!existed) return false;
  const hash = createHash("sha256").update(challenge + nonce).digest("hex");
  return hash.startsWith("0".repeat(POW_DIFFICULTY));
}

// startsAt is null until the sale is scheduled; the client counts down to it
async function saleState() {
  const [open, stock, startsAt] = await redis.mget(KEYS.open, KEYS.stock, KEYS.startsAt);
  const now = Date.now();
  const start = open === "1" ? Number(startsAt ?? 0) : null;
  return { open: start !== null && now >= start, startsAt: start, remaining: Number(stock ?? 0), now };
}

app.get("/sale/status", saleState);

app.post("/checkout", async (req, reply) => {
  const userId = authUser(req);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });

  if (POW_ENABLED) {
    const ok = await powValid(
      req.headers["x-pow-challenge"] as string | undefined,
      req.headers["x-pow-nonce"] as string | undefined
    );
    if (!ok) return reply.code(403).send({ error: "pow_failed" });
  }

  // 5 attempts per user per 10s
  const k = `rl:${userId}`;
  const hits = await redis.incr(k);
  if (hits === 1) await redis.expire(k, 10);
  if (hits > 5) return reply.code(429).send({ error: "rate_limited" });

  if (!(await saleState()).open) return reply.code(409).send({ status: "NOT_OPEN" });

  const r = (await redis.eval(RESERVE_LUA, 2, KEYS.stock, KEYS.buyers, userId)) as number;
  if (r === -1) return reply.code(409).send({ status: "ALREADY_PURCHASED" });
  if (r === 0) return reply.code(410).send({ status: "SOLD_OUT" });

  const orderId = randomUUID();
  try {
    await redis.hset(KEYS.order(orderId), { status: "QUEUED", userId });
    channel.sendToQueue(
      QUEUE,
      Buffer.from(JSON.stringify({ orderId, userId, productId: PRODUCT_ID })),
      { persistent: true, messageId: orderId }
    );
  } catch (e) {
    req.log.error(e, "enqueue failed");
    await redis.eval(RELEASE_LUA, 2, KEYS.stock, KEYS.buyers, userId);
    await redis.del(KEYS.order(orderId));
    return reply.code(503).send({ error: "enqueue_failed" });
  }
  return reply.code(202).send({ orderId, pollUrl: `/api/orders/${orderId}` });
});

app.get<IdParams>("/orders/:id", async (req, reply) => {
  const userId = authUser(req);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });
  const o = await redis.hgetall(KEYS.order(req.params.id));
  if (!o.status || o.userId !== userId) return reply.code(404).send({ error: "not_found" });
  return { status: o.status };
});

// mock payment, low volume so it can go straight to the db
app.post<IdParams>("/orders/:id/pay", async (req, reply) => {
  const userId = authUser(req);
  if (!userId) return reply.code(401).send({ error: "unauthorized" });
  const { id } = req.params;
  const r = await pool.query(
    `UPDATE orders SET status = 'CONFIRMED'
     WHERE id = $1 AND user_id = $2 AND status = 'PENDING_PAYMENT'`,
    [id, userId]
  );
  if (r.rowCount === 0) return reply.code(409).send({ error: "not_payable" });
  await redis.hset(KEYS.order(id), "status", "CONFIRMED");
  return { status: "CONFIRMED" };
});

await app.listen({ port: 3000, host: "0.0.0.0" });
