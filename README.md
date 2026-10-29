# ALB Load-Balancer Tester

A tiny site for exercising two Datum HTTPProxy features against real backends:

- **Weighted backends per rule** ([network-services-operator#453](https://github.com/datum-cloud/network-services-operator/pull/453))
- **Load-balancing algorithm** — RoundRobin, Random, LeastRequest, ConsistentHash ([#455](https://github.com/datum-cloud/network-services-operator/pull/455))
- **Passive health checks** — outlier detection ejecting a backend that returns 5xx

It has two halves:

1. **Origin echo** at `GET /api/whoami` — returns JSON naming which backend served the request (`backendId`), plus the client IP, Host header, and the `x-lb-key` header. This is what your HTTPProxy backends point at. Deploy it two or three times so you have distinct origins. Add `?fail=<backendId>` (comma-separated, or `*`) and the named backend misbehaves instead: by default it answers `?failStatus` (default 503), and it can also answer slowly, hang, or fail only some requests (see [Failure injection](#failure-injection)). Every other backend ignores it.
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
| Health checks: slow, hang, flaky | **Health checks** tab, *How it fails*: Delay, Jitter, Hang, or *Fail %* under 100, RoundRobin proxy | Hang ejects after ~5 proxy timeouts; a delay under the proxy timeout is never ejected; a partial failure ejects only once 5 fail in a row |
| Timeouts & retries | **Timeouts & retries** tab, one Compute instance, Hang | Each request shows whether the proxy waited, retried elsewhere, or returned its own error, and after how long |

## Features

The dashboard has five tabs, all driven by the shared proxy URL at the top.

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

**Health checks** — makes one backend, or one instance of a backend, fail and checks outlier detection. **Detect** lists the backends behind the proxy and, for any backend answering from more than one instance, its instances; pick one to fail. The run sends a steady stream in three phases: *baseline* (nothing fails), *failing* (requests carry `?fail=<backend or instance>`, so only that one misbehaves), and *recovery*. **How it fails** picks the failure: answer **5xx** (pick the status), answer after a **delay** or a random delay in a range (**jitter**), or **hang**. **Fail %** fails only that share of the target's requests, for a flaky-not-dead endpoint. It reports:
- When the target was **ejected** (no traffic to it for a stretch in which, at its baseline share, it should have had several requests) and how many failures it returned first
- How often the proxy **retried** it while it was still failing, each time an ejection period ended
- How long after the failures stopped it was **re-admitted**
- A per-second timeline of which backend or instance answered, with target 5xx and proxy-generated 5xx marked, and each one's share per phase

Requests go through the server-side probe so a 503 the proxy generates itself (no CORS headers) is still counted, and told apart from the backend's own 503. A run that falls well below the requested rate is reported as inconclusive unless it still has enough failures to decide.

In the slow modes a request only counts as a failure if the proxy gives up on it first (15s on Datum) and returns its own 504. Only the target misbehaves, so that 504 is counted as a **timeout on the target**, at the time the proxy gave up. A delay shorter than the proxy's timeout is just a slow 200: passive health checks don't eject for latency, and the run says so. Two things to know for slow-mode runs:
- **Use a RoundRobin load balancer.** With LeastRequest the proxy already sends less traffic to an endpoint that has requests stuck on it, which looks like an ejection before there is one.
- **Keep the rate low when running locally** (2–3 req/s). Over HTTP/1.1 the browser holds only 6 connections to the dashboard, so hung requests make the rest queue. Each request is timed from when it actually left, so the results stay right, but the timeline shows gaps and bursts.

### What outlier detection does, and how to test it

Outlier detection ejects **endpoints within a backend**. It doesn't move traffic between backends: a backend whose every endpoint fails keeps its weighted share. So failing a whole Vercel backend (one app behind shared anycast IPs) will always report *not ejected*, and that's the expected result.

To see an ejection, fail one endpoint of a backend that has several. Run the tester as a **Datum Compute workload with 3 instances** and add it to the load balancer as a Datum compute backend (see `examples/health-check-compute.yaml`). Three instances rather than two: with max ejected at 50% one of three can go, and the other two keep the backend well above the proxy's panic threshold, where it would ignore health and route to every endpoint.

**Timeouts & retries** — makes one backend or instance **hang**, answer after a **delay**, or answer **5xx**, and shows what the proxy did with each request. Every endpoint gets the same request and only the target misbehaves, so each response says what happened:
- the target answered: the proxy **waited** for it, or passed its 5xx on
- another endpoint answered, but more than a second slower than baseline: the proxy tried the target, gave up, and **retried** elsewhere
- no origin answered: the proxy **gave up** and returned its own error (status and how long it waited)

It reports these counts, the target's share against baseline, a latency plot of every request, and a per-request table. Keep **Give up after** longer than the proxy's own timeout, so the run sees the proxy give up rather than the dashboard. A 5xx the proxy retries at once can't be told apart by timing from a request that never went to the target; a drop in the target's share is the sign of it.

## Failure injection

`?fail=<backend or instance>` picks who misbehaves; everything else is optional. Requests without `?fail`, and backends it doesn't name, answer normally.

| Parameter | Values | Default | Effect |
| --- | --- | --- | --- |
| `failMode` | `error`, `delay`, `jitter`, `hang` | `error` | How the named target misbehaves |
| `failStatus` | 500–599 | 503 | Status returned in `error` mode |
| `delayMs` | 0–60000 | 1000 | Wait before answering 200, in `delay` mode |
| `jitterMin`, `jitterMax` | 0–60000 | 100, 2000 | Random wait range before answering 200, in `jitter` mode |
| `failPercent` | 0–100 | 100 | Share of matching requests that misbehave; the rest answer normally |

`hang` holds the request open without answering, so the proxy's own timeout decides what happens. The origin gives up on a hung request when the client disconnects, or after 10 minutes with a 504. Responses that were delayed or failed carry an `x-fail-mode` header, and delayed ones also include `failMode` and `delayedMs` in the body.

```bash
# backend-b answers after 3 seconds
curl "https://<proxy>/api/whoami?fail=backend-b&failMode=delay&delayMs=3000"

# one instance hangs on 30% of requests
curl "https://<proxy>/api/whoami?fail=ab12cd&failMode=hang&failPercent=30"
```

## Run on Datum Compute

Datum Compute runs unikernels, so the image is built with `datumctl compute build` from `Dockerfile.datum` rather than `docker build`. The final stage is distroless Node (the binary and the shared libraries it links against, no shell) running Next's standalone server; `--analyze` checks the entrypoint and its libraries before packaging.

The **Compute image** workflow builds it on every push to `main` that touches the app and publishes `ghcr.io/datum-labs/alb-lb-tester:latest` and `:sha-<commit>`. To build by hand, with Docker running and a GHCR login that can write packages:

```bash
datumctl compute build --analyze --push --output ghcr.io/<you>/alb-lb-tester:latest .
```

Then create a Compute workload from the image with **3 instances**, port `http` on **3000**, and environment `BACKEND_ID=compute`:

```bash
datumctl compute deploy alb-lb-tester --image ghcr.io/datum-labs/alb-lb-tester:latest \
  --location us-central-1 --min 3 --http-port 3000 --env BACKEND_ID=compute
```

The server binds `::` because Compute instances only have IPv6 addresses; an image built before that fix needs `--env HOSTNAME=::`. Each instance picks its own id at start; set `INSTANCE_ID` to name them yourself. The repository and its package are public, so the workload needs no image pull secret. A project without a network named `default` needs `--network <name> --yes`, which creates one.

### Regular container image

The same workflow also builds `Dockerfile.datum` with plain Docker and publishes it as `ghcr.io/datum-labs/alb-lb-tester:container-latest` and `:container-sha-<commit>`. The `latest` and `sha-*` tags are unikernel images and run only on Compute's default unikernel runtime; the `container-*` tags run anywhere a container does, including Compute's general-purpose runtime:

```bash
datumctl compute deploy alb-lb-tester-gp --image ghcr.io/datum-labs/alb-lb-tester:container-latest   --runtime-class general-purpose --location us-east-1 --min 3 --http-port 3000 --env BACKEND_ID=compute-gp

docker run -p 3000:3000 -e BACKEND_ID=local ghcr.io/datum-labs/alb-lb-tester:container-latest
```

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
