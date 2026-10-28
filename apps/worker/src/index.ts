import amqp from "amqplib";
import pg from "pg";
import { Redis } from "ioredis";
import { QUEUE, KEYS, RELEASE_LUA } from "@flash/shared";

const PAYMENT_TIMEOUT = "2 minutes";

const redis = new Redis(process.env.REDIS_URL!);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const conn = await amqp.connect(process.env.AMQP_URL!);
const ch = await conn.createChannel();
await ch.assertQueue(QUEUE, { durable: true });
await ch.prefetch(20);

type OrderMsg = { orderId: string; userId: string; productId: number };

const release = (userId: string) =>
  redis.eval(RELEASE_LUA, 2, KEYS.stock, KEYS.buyers, userId);
const setStatus = (orderId: string, s: string) =>
  redis.hset(KEYS.order(orderId), "status", s);

function parse(content: Buffer): OrderMsg | null {
  try {
    const m = JSON.parse(content.toString());
    if (typeof m.orderId === "string" && typeof m.userId === "string") return m;
  } catch {}
  return null;
}

ch.consume(QUEUE, async (msg) => {
  if (!msg) return;
  const order = parse(msg.content);
  if (!order) {
    // no dead-letter queue, so drop it instead of letting it loop
    console.error("dropping bad message", msg.content.toString().slice(0, 200));
    ch.ack(msg);
    return;
  }
  const { orderId, userId, productId } = order;

  let client: pg.PoolClient | undefined;
  let committed = false;
  try {
    client = await pool.connect();
    await client.query("BEGIN");

    // redelivered message: the row is already there, just resync redis
    const ins = await client.query(
      `INSERT INTO orders (id, user_id, product_id, status)
       VALUES ($1, $2, $3, 'PENDING_PAYMENT') ON CONFLICT (id) DO NOTHING`,
      [orderId, userId, productId]
    );
    if (ins.rowCount === 0) {
      await client.query("ROLLBACK");
      const existing = await client.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      if (existing.rows[0]) await setStatus(orderId, existing.rows[0].status);
      ch.ack(msg);
      return;
    }

    const upd = await client.query(
      `UPDATE inventory SET stock = stock - 1 WHERE product_id = $1 AND stock > 0`,
      [productId]
    );
    if (upd.rowCount === 0) {
      await client.query("ROLLBACK");
      await release(userId);
      await setStatus(orderId, "SOLD_OUT");
      ch.ack(msg);
      return;
    }

    await client.query("COMMIT");
    committed = true;
    await setStatus(orderId, "PENDING_PAYMENT");
    ch.ack(msg);
  } catch (e: any) {
    await client?.query("ROLLBACK").catch(() => {});
    if (committed) {
      // order is in the db, only the redis status write failed
      ch.ack(msg);
      return;
    }
    console.error(`order ${orderId} failed:`, e.message);
    try {
      // 23505 = user already has an active order, their token is legit so keep it
      if (e.code !== "23505") await release(userId);
      await setStatus(orderId, "FAILED");
    } catch (err) {
      console.error("cleanup failed", err);
    }
    ch.ack(msg);
  } finally {
    client?.release();
  }
});

async function expireUnpaid() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await c.query(
      `UPDATE orders SET status = 'EXPIRED'
       WHERE status = 'PENDING_PAYMENT' AND created_at < now() - $1::interval
       RETURNING id, user_id, product_id`,
      [PAYMENT_TIMEOUT]
    );
    for (const o of r.rows)
      await c.query(`UPDATE inventory SET stock = stock + 1 WHERE product_id = $1`, [o.product_id]);
    await c.query("COMMIT");
    for (const o of r.rows) {
      await release(o.user_id);
      await setStatus(o.id, "EXPIRED");
    }
    if (r.rowCount) console.log(`expired ${r.rowCount} unpaid orders`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    console.error("expiry job failed", e);
  } finally {
    c.release();
  }
}

setInterval(() => expireUnpaid().catch((e) => console.error(e)), 10_000);

console.log("worker ready");
