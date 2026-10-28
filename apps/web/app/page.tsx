"use client";
import { useEffect, useRef, useState } from "react";

async function sha256hex(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const json = { "content-type": "application/json" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const LABELS: Record<string, string> = {
  idle: "Ready",
  NOT_OPEN: "Sale hasn't started yet",
  working: "Buying...",
  QUEUED: "In the queue, hang on",
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
  const [sale, setSale] = useState<{ open: boolean; remaining: number } | null>(null);
  const busy = useRef(false); // ref, not state, so a fast double click can't slip through

  useEffect(() => {
    let stop = false;
    (async () => {
      while (!stop) {
        try {
          const r = await fetch("/api/sale/status");
          if (r.ok) setSale(await r.json());
        } catch {}
        await sleep(3000);
      }
    })();
    return () => {
      stop = true;
    };
  }, []);

  async function buy() {
    if (busy.current) return;
    busy.current = true;
    setState("working");
    try {
      const login = await (
        await fetch("/api/auth/login", { method: "POST", headers: json, body: JSON.stringify({ userId }) })
      ).json();
      const auth = { authorization: `Bearer ${login.token}` };
      setToken(login.token);

      const ch = await (await fetch("/api/pow/challenge")).json();
      const prefix = "0".repeat(ch.difficulty);
      let nonce = 0;
      while (!(await sha256hex(ch.challenge + nonce)).startsWith(prefix)) nonce++;

      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { ...auth, "x-pow-challenge": ch.challenge, "x-pow-nonce": String(nonce) },
      });
      const body = await res.json().catch(() => ({}));
      if (res.status !== 202) {
        setState(body.status ?? body.error ?? "ERROR");
        return;
      }
      setOrderId(body.orderId);
      setState("QUEUED");

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

  return (
    <main style={{ maxWidth: 420, margin: "60px auto", padding: "0 16px", fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ marginBottom: 4 }}>Flash Sale: 500 phones</h1>
      <p style={{ marginTop: 0, color: "#666" }}>
        {!sale ? "Checking sale..." : !sale.open ? "Waiting for the sale to open" : `${sale.remaining} left`}
      </p>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          placeholder="user id"
          style={{ flex: 1, padding: 8 }}
        />
        <button onClick={buy} disabled={locked || !userId} style={{ padding: "8px 16px" }}>
          Buy now
        </button>
      </div>

      <p>
        Status: <b>{LABELS[state] ?? state}</b>
      </p>
      {state === "PENDING_PAYMENT" && <button onClick={pay}>Pay (mock)</button>}
    </main>
  );
}
