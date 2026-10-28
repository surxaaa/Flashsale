"use client";
import { useEffect, useRef, useState } from "react";

type Sale = { open: boolean; startsAt: number | null; remaining: number; now: number };
type Ticket = { userId: string; token: string; challenge: string; nonce: number; at: number };

const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CHALLENGE_TTL = 50_000; // server keeps challenges for 60s
const PREPARE_WINDOW = 45_000; // start logging in / solving PoW this long before the sale

async function sha256hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// login + proof-of-work, done ahead of time so the click only sends the checkout
async function prepare(userId: string): Promise<Ticket> {
  const login = await (
    await fetch("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ userId }) })
  ).json();
  const ch = await (await fetch("/api/pow/challenge")).json();
  const prefix = "0".repeat(ch.difficulty);
  let nonce = 0;
  while (!(await sha256hex(ch.challenge + nonce)).startsWith(prefix)) nonce++;
  return { userId, token: login.token, challenge: ch.challenge, nonce, at: Date.now() };
}

function countdown(ms: number) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

const LABELS: Record<string, string> = {
  idle: "Ready",
  NOT_OPEN: "Sale hasn't started yet",
  working: "You're in line...",
  QUEUED: "You're in line...",
  PENDING_PAYMENT: "Reserved! Pay within 2 minutes",
  CONFIRMED: "Order confirmed",
  SOLD_OUT: "Sold out",
  ALREADY_PURCHASED: "You already have one",
  EXPIRED: "Reservation expired",
  FAILED: "Order failed, try again",
  rate_limited: "Too many attempts, slow down",
  ERROR: "Something went wrong",
};

export default function Page() {
  const [userId, setUserId] = useState("u1");
  const [state, setState] = useState("idle");
  const [orderId, setOrderId] = useState("");
  const [token, setToken] = useState("");
  const [sale, setSale] = useState<Sale | null>(null);
  const [now, setNow] = useState(0);
  const offset = useRef(0); // server clock minus ours
  const busy = useRef(false); // ref, not state, so a fast double click can't slip through
  const ticket = useRef<Promise<Ticket | null> | null>(null);

  useEffect(() => {
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const r = await fetch("/api/sale/status");
          if (r.ok) {
            const s: Sale = await r.json();
            offset.current = s.now - Date.now();
            setSale(s);
          }
        } catch {}
        await sleep(3000);
      }
    })();
    const tick = setInterval(() => setNow(Date.now() + offset.current), 250);
    return () => {
      stop = true;
      clearInterval(tick);
    };
  }, []);

  const startsIn = sale?.startsAt != null && now ? sale.startsAt - now : Infinity;
  const live = startsIn <= 0;
  const soon = startsIn <= PREPARE_WINDOW;

  useEffect(() => {
    if (!userId || !soon) return;
    const t = setTimeout(() => {
      ticket.current = prepare(userId).catch(() => null);
    }, 400);
    return () => clearTimeout(t);
  }, [userId, soon]);

  async function buy() {
    if (busy.current) return;
    busy.current = true;
    setState("working"); // show the queue state straight away, before any network
    try {
      let t = await ticket.current;
      ticket.current = null; // challenges are single use
      if (!t || t.userId !== userId || Date.now() - t.at > CHALLENGE_TTL) t = await prepare(userId);
      const auth = { authorization: `Bearer ${t.token}` };
      setToken(t.token);

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { ...auth, "x-pow-challenge": t.challenge, "x-pow-nonce": String(t.nonce) },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 202) {
        setState(body.status ?? body.error ?? "ERROR");
        return;
      }
      setOrderId(body.orderId);
      setState("QUEUED");
      setSale((s) => s && { ...s, remaining: Math.max(0, s.remaining - 1) });

      // backoff 500ms -> 3s, with a bit of jitter so clients don't sync up
      let delay = 500;
      for (;;) {
        await sleep(delay + Math.random() * 200);
        delay = Math.min(delay * 1.5, 3000);
        const r = await fetch(body.pollUrl, { headers: auth });
        if (r.status === 404) {
          setState("FAILED");
          return;
        }
        if (!r.ok) continue;
        const o = await r.json();
        if (o.status !== "QUEUED") {
          setState(o.status);
          return;
        }
      }
    } catch {
      setState("ERROR");
    } finally {
      busy.current = false;
    }
  }

  async function pay() {
    const r = await fetch(`/api/orders/${orderId}/pay`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await r.json().catch(() => ({}));
    setState(body.status ?? "EXPIRED");
  }

  const locked = state === "working" || state === "QUEUED";

  let headline = "Checking sale...";
  if (sale && sale.startsAt == null) headline = "Sale not scheduled yet";
  else if (sale && !live) headline = `Opens at ${new Date(sale.startsAt!).toLocaleTimeString()}`;
  else if (sale) headline = sale.remaining > 0 ? `${sale.remaining} left` : "Sold out";

  return (
    <main style={{ maxWidth: 420, margin: "60px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 4 }}>Flash Sale: 500 phones</h1>
      <p style={{ marginTop: 0, color: "#666" }}>{headline}</p>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="user id"
          style={{ flex: 1, padding: 8 }}
        />
        <button
          onClick={buy}
          disabled={locked || !userId || !live}
          style={{ padding: "8px 16px", minWidth: 110, fontVariantNumeric: "tabular-nums" }}
        >
          {live || !Number.isFinite(startsIn) ? "Buy now" : countdown(startsIn)}
        </button>
      </div>

      <p>
        Status: <b>{LABELS[state] ?? state}</b>
      </p>
      {state === "PENDING_PAYMENT" && <button onClick={pay}>Pay (mock)</button>}
    </main>
  );
}
