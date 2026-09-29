# ALB Load-Balancer Tester

A tiny site for exercising two Datum HTTPProxy features against real backends:

- **Weighted backends per rule** ([network-services-operator#453](https://github.com/datum-cloud/network-services-operator/pull/453))
- **Load-balancing algorithm** — RoundRobin, Random, LeastRequest, ConsistentHash ([#455](https://github.com/datum-cloud/network-services-operator/pull/455))
- **Passive health checks** — outlier detection ejecting a backend that returns 5xx

It has two halves:

1. **Origin echo** at `GET /api/whoami` — returns JSON naming which backend served the request (`backendId`), plus the client IP, Host header, and the `x-lb-key` header. This is what your HTTPProxy backends point at. Deploy it two or three times so you have distinct origins. Add `?fail=<backendId>` (comma-separated, or `*`) and the named backend answers with `?failStatus` (default 503) instead; every other backend ignores it.
2. **Dashboard** at `/` — fires a burst of requests through your proxy URL and charts which backend served each one, so you can see weights and algorithms at work.

## Deploy the backends to Vercel

Deploy this repo as **two or three separate Vercel projects**, each with a distinct `BACKEND_ID` environment variable:

| Project | `BACKEND_ID` | Example URL |
| --- | --- | --- |
| alb-tester-a | `backend-a` | `https://alb-tester-a.vercel.app` |
| alb-tester-b | `backend-b` | `https://alb-tester-b.vercel.app` |
| alb-tester-c | `backend-c` | `https://alb-tester-c.vercel.app` |

```bash
bun add -g vercel
vercel --prod -e BACKEND_ID=backend-a   # repeat per project
```

If you skip `BACKEND_ID`, each deployment falls back to labelling itself by its Vercel hostname, which still works but reads less cleanly. The same deployment also serves the dashboard, so open any one of the URLs in a browser to drive tests.

## Point an HTTPProxy at them

The `examples/` folder has ready manifests. Set the endpoints to your deployed URLs, then apply against your project. Two weighted origins:

```yaml
apiVersion: networking.datumapis.com/v1alpha
kind: HTTPProxy
metadata:
  name: lb-tester-weighted
spec:
  rules:
    - backends:
        - endpoint: https://alb-tester-a.vercel.app
          weight: 80
        - endpoint: https://alb-tester-b.vercel.app
          weight: 20
```

## Run a test

Open the dashboard, enter your **proxy hostname** (e.g. `https://your-alb.datumproxy.net`), and send traffic.

| Feature | How to test | Expected |
| --- | --- | --- |
| Weighted backends | Weighted manifest, key mode None, 200 requests | Distribution near the weight ratio |
| RoundRobin / Random / LeastRequest | Equal-weight manifest, key mode None | Near-even split across backends |
| ConsistentHash on header, sticky | Hash manifest with `header: x-lb-key`, key mode **Constant** | All requests hit one backend |
| ConsistentHash on header, spread | Same manifest, key mode **Random** | Requests spread across backends |
| ConsistentHash on source IP | SourceIP manifest, key mode None | All requests stick to one backend (one client IP) |
| Passive health checks | Health-check manifest, **Health checks** tab, fail one backend | Target ejected after ~5 failures, retried after 30s, re-admitted once failures stop |

## Features

The dashboard has four tabs, all driven by the shared proxy URL at the top.

**Load balancing** — fire a burst (or a continuous **Live** stream with a rolling req/s meter) and see:
- Distribution bars per backend, with **expected-vs-observed** deltas when you enter the weights you configured
- A **sequence strip** showing which backend served each request in order, so RoundRobin vs Random vs LeastRequest is visible at a glance
- A **per-backend table** with request share and p50/p95 latency
- Sticky-session verdict for ConsistentHash, and **CSV export** of the run

**Headers & redirect** — inspects the target from the server (past browser CORS) and reports:
- The **Host** the origin actually received, flagged when the proxy overrode it
- Whether **HSTS** is set, and the full request/response header dumps
- Whether **http redirects to https**

**WAF probes** — sends a set of XSS, SQLi, command-injection and traversal payloads plus benign requests, and reports the block rate, any false positives, and a per-payload table.

**Health checks** — makes one backend fail and checks outlier detection. **Detect** lists the backends behind the proxy; pick one to fail. The run sends a steady stream in three phases: *baseline* (nothing fails), *failing* (requests carry `?fail=<backend>`, so only that backend returns 5xx), and *recovery*. It reports:
- When the target was **ejected** (3 seconds with no traffic to it) and how many 5xx it returned first
- How often the proxy **retried** it while it was still failing, each time an ejection period ended
- How long after the failures stopped it was **re-admitted**
- A per-second timeline of which backend answered, with target 5xx and proxy-generated 5xx marked, and each backend's share per phase

Requests go through the server-side probe so a 503 the proxy generates itself (no CORS headers) is still counted, and told apart from the backend's own 503.

If the target is never ejected, check that outlier detection is on. Backends on different hostnames each get their own upstream; when one of those has a single endpoint, ejecting it leaves no healthy host, and the proxy may keep routing to it.

## Notes

- The echo endpoint sends permissive CORS headers so the browser can read responses through the proxy.
- Responses set `Cache-Control: no-store` and the dashboard adds a cache-buster, so every request reaches an origin.
- The distribution counts each backend by the `backendId` in its response, so a warm serverless instance and a cold one under the same `BACKEND_ID` still count as one backend, which is what you want when reasoning about the proxy's routing.

## Local development

Built with Next.js 16, React 19, Tailwind v4, and the @datum-cloud/datum-ui design system.

```bash
bun install
bun run dev
# open http://localhost:3000
```
