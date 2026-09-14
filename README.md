# ALB Load-Balancer Tester

A tiny site for exercising two Datum HTTPProxy features against real backends:

- **Weighted backends per rule** ([network-services-operator#453](https://github.com/datum-cloud/network-services-operator/pull/453))
- **Load-balancing algorithm** — RoundRobin, Random, LeastRequest, ConsistentHash ([#455](https://github.com/datum-cloud/network-services-operator/pull/455))

It has two halves:

1. **Origin echo** at `GET /api/whoami` — returns JSON naming which backend served the request (`backendId`), plus the client IP, Host header, and the `x-lb-key` header. This is what your HTTPProxy backends point at. Deploy it two or three times so you have distinct origins.
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
