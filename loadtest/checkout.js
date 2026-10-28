import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const accepted = new Counter("accepted_202");
const soldOut = new Counter("sold_out_410");
const limited = new Counter("rate_limited_429");

export const options = {
  scenarios: {
    burst: {
      executor: "per-vu-iterations",
      vus: Number(__ENV.VUS || 3000),
      iterations: 1,
      maxDuration: "60s",
    },
  },
  // 410 and 429 are expected responses, not failures
  thresholds: { http_req_failed: ["rate<0.01"] },
};

const BASE = __ENV.BASE || "http://localhost:8080";

export default function () {
  const userId = `load-${__VU}`;
  const login = http.post(`${BASE}/api/auth/login`, JSON.stringify({ userId }), {
    headers: { "content-type": "application/json" },
  });
  const token = login.json("token");

  const res = http.post(`${BASE}/api/checkout`, null, {
    headers: { authorization: `Bearer ${token}` },
    responseCallback: http.expectedStatuses(202, 410, 429),
  });

  if (res.status === 202) accepted.add(1);
  if (res.status === 410) soldOut.add(1);
  if (res.status === 429) limited.add(1);
  check(res, { "no 5xx": (r) => r.status < 500 });
}
