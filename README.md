# ALB Load-Balancer Tester

A tiny site for exercising two Datum HTTPProxy features against real backends:

- **Weighted backends per rule** ([network-services-operator#453](https://github.com/datum-cloud/network-services-operator/pull/453))
- **Load-balancing algorithm** — RoundRobin, Random, LeastRequest, ConsistentHash ([#455](https://github.com/datum-cloud/network-services-operator/pull/455))
- **Passive health checks** — outlier detection ejecting a backend that returns 5xx

It has two halves:

1. **Origin echo** at `GET /api/whoami` — returns JSON naming which backend served the request (`backendId`), plus the client IP, Host header, and the `x-lb-key` header. This is what your HTTPProxy backends point at. Deploy it two or three times so you have distinct origins. Add `?fail=<backendId>` (comma-separated, or `*`) and the named backend misbehaves instead: by default it answers `?failStatus` (default 503), and it can also answer slowly, hang, or fail only some requests (see [Failure injection](#failure-injection)). Every other backend ignores it. Behind a login, one instance can also be left broken for every request until it's reset (see [Sticky failure](#sticky-failure)).
2. **Dashboard** at `/` — fires a burst of requests through your proxy URL and charts which backend served each one, so you can see weights and algorithms at work.

## Setup

The dashboard's **Setup** page (`/setup`, linked from its header) is the guide to what runs where: the parts, which path test traffic takes from each tab (Server or Browser mode), the three ways to run the tester, its settings, and a quick start for each. In short:

- **Local or another cloud**: the dashboard on your machine or a VM (`npm run dev`, or the `container-latest` image), the origins on Datum Compute behind your HTTPProxy. Tests run from the dashboard's server.
- **Hosted on Datum Compute**: one workload with `DASHBOARD_AUTH` is both the dashboard and the origins. A dashboard on Datum Compute can't currently reach Datum proxies, so proxy tests run from the browser ([browser mode](#browser-mode)).
- **CI origin only**: `ORIGIN_ONLY=1`, only `/api/whoami`, for automated tests.

## Deploy the backends to Vercel

Deploy this repo as **two or three separate Vercel projects**, each with a distinct `BACKEND_ID` environment variable:

| Project | `BACKEND_ID` | Example URL |
| --- | --- | --- |
| alb-tester-a | `backend-a` | `https://alb-tester-a.vercel.app` |
| alb-tester-b | `backend-b` | `https://alb-tester-b.vercel.app` |
| alb-tester-c | `backend-c` | `https://alb-tester-c.vercel.app` |

```bash
npm install -g vercel
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
| Failover between instances | `failover-compute.yaml`, **Health checks** tab, fail one of 3 Compute instances | 5xx: ejected ~1s in after 3 failures; hang: ejected after 3 proxy timeouts (~18s); let back in once it recovers |
| Timeouts & retries | **Timeouts & retries** tab, one Compute instance, Hang | Each request shows whether the proxy waited, retried elsewhere, or returned its own error, and after how long |

## Features

The dashboard has five tabs, all driven by the shared proxy URL at the top, plus a sixth, **Sticky failure**, behind a login (see [Sticky failure](#sticky-failure)). Below the URL, **Send test traffic from: Server | Browser** picks who sends the requests for Headers & redirect, WAF probes, Health checks and Timeouts & retries (see [Browser mode](#browser-mode)). Load balancing always runs from the browser, Sticky failure always from the server.

**Load balancing** — fire a burst (or a continuous **Live** stream with a rolling req/s meter) and see:
- Distribution bars per backend, with **expected-vs-observed** deltas when you enter the weights you configured
- A **sequence strip** showing which backend served each request in order, so RoundRobin vs Random vs LeastRequest is visible at a glance
- A **per-backend table** with request share and p50/p95 latency
- Sticky-session verdict for ConsistentHash, and **CSV export** of the run

**Headers & redirect** — inspects the target from the server (past browser CORS) and shows what the edge does to headers in both directions. It compares what was sent with what the origin received (request), and what the origin sent back with what arrived (response), and labels each header **unchanged**, **added**, **removed**, **rewritten** or **appended**. Headers that change at every hop (`Connection`, `Date`, `Transfer-Encoding`, ...) are listed apart and not counted. It also reports:
- The **Host** the origin actually received, flagged when the proxy overrode it
- Whether **HSTS** is set
- Whether **http redirects to https**

Add your own **request headers to send** (for example a fake `X-Forwarded-For`) and headers for the **origin to send back** (`Server`, `Set-Cookie`, `Cache-Control`, CORS, ...), one `Name: Value` per line, or start from a preset. The **Client address** preset sends fake forwarding headers and says which header an app can trust for the client address, and which ones a client can set to anything. **Copy as evidence** copies the result as a short markdown table for a ticket or docs PR.

Things to know:
- The inspector runs on the dashboard's server, so "client address" is that server's address, not your browser's. To check from your own machine, use browser mode or curl (see [Headers](#headers)).
- The whole inspection has an 11s budget, inside the 15s a Datum proxy in front of the dashboard allows, so a target that doesn't answer comes back as an error naming it rather than the edge's 504 page.
- Origin headers need the target to be this tester's `/api/whoami`. The request comparison needs the origin to report headers as they arrived: the Datum Compute image does (`raw-headers.cjs` records them before Next fills in missing `X-Forwarded-*`); other deployments are flagged, because a forwarding header shown as added may come from Next, not the edge.
- HTTP/2 lowercases header names and fetch doesn't keep their order, so case and order can't be checked.
- The inspector, and the server-side probe the health checks use, only fetch `http` and `https` URLs on public addresses. Loopback, private, link-local and similar addresses are refused, after DNS and on every redirect, so the public dashboard can't be used to reach the network it runs in. `next dev` lifts this, as does `ALLOW_PRIVATE_TARGETS=1`, for testing an origin on your own machine. Behind a login (`DASHBOARD_AUTH`, see [Run on Datum Compute](#run-on-datum-compute)), they can also reach this network's instances by internal name, `<workload>-<network>-<location>-<n>.instances.datum.internal`.

**WAF probes** — sends a set of XSS, SQLi, command-injection and traversal payloads plus benign requests, and reports the block rate, any false positives, and a per-payload table.

**Health checks** — makes one backend, or one instance of a backend, fail and checks outlier detection. **Detect** lists the backends behind the proxy and, for any backend answering from more than one instance, its instances; pick one to fail. The run sends a steady stream in three phases: *baseline* (nothing fails), *failing* (requests carry `?fail=<backend or instance>`, so only that one misbehaves), and *recovery*. **How it fails** picks the failure: answer **5xx** (pick the status), answer after a **delay** or a random delay in a range (**jitter**), or **hang**. **Fail %** fails only that share of the target's requests, for a flaky-not-dead endpoint. It reports:
- When the target was **ejected** (no traffic to it for a stretch in which, at its baseline share, it should have had several requests) and how many failures it returned first
- How often the proxy **retried** it while it was still failing, each time an ejection period ended
- How long after the failures stopped it was **re-admitted**
- A per-second timeline of which backend or instance answered, with target 5xx and proxy-generated 5xx marked, and each one's share per phase

Requests go through the server-side probe so a 503 the proxy generates itself (no CORS headers) is still counted, and told apart from the backend's own 503 (in browser mode, see its limits below). A run that falls well below the requested rate is reported as inconclusive unless it still has enough failures to decide.

In the slow modes a request only counts as a failure if the proxy gives up on it first (15s on Datum) and returns its own 504. Only the target misbehaves, so that 504 is counted as a **timeout on the target**, at the time the proxy gave up. A delay shorter than the proxy's timeout is just a slow 200: passive health checks don't eject for latency, and the run says so. Two things to know for slow-mode runs:
- **Use a RoundRobin load balancer.** With LeastRequest the proxy already sends less traffic to an endpoint that has requests stuck on it, which looks like an ejection before there is one.
- **Keep the rate low when running locally** (2–3 req/s). Over HTTP/1.1 the browser holds only 6 connections to the dashboard, so hung requests make the rest queue. Each request is timed from when it actually left, so the results stay right, but the timeline shows gaps and bursts.

### What outlier detection does, and how to test it

Outlier detection ejects **endpoints within a backend**. It doesn't move traffic between backends: a backend whose every endpoint fails keeps its weighted share. So failing a whole Vercel backend (one app behind shared anycast IPs) will always report *not ejected*, and that's the expected result.

To see an ejection, fail one endpoint of a backend that has several. For failover, `examples/failover-compute.yaml` tunes the same settings to eject after 3 failures for 10s. HTTPProxy has no primary/fallback backend, so failover is always between the instances of one backend. Run the tester as a **Datum Compute workload with 3 instances** and add it to the load balancer as a Datum compute backend (see `examples/health-check-compute.yaml`). Three instances rather than two: with max ejected at 50% one of three can go, and the other two keep the backend well above the proxy's panic threshold, where it would ignore health and route to every endpoint.

**Timeouts & retries** — makes one backend or instance **hang**, answer after a **delay**, or answer **5xx**, and shows what the proxy did with each request. Every endpoint gets the same request and only the target misbehaves, so each response says what happened:
- the target answered: the proxy **waited** for it, or passed its 5xx on
- another endpoint answered, but more than a second slower than baseline: the proxy tried the target, gave up, and **retried** elsewhere
- no origin answered: the proxy **gave up** and returned its own error (status and how long it waited)

It reports these counts, the target's share against baseline, a latency plot of every request, and a per-request table. Keep **Give up after** longer than the proxy's own timeout, so the run sees the proxy give up rather than the dashboard. A 5xx the proxy retries at once can't be told apart by timing from a request that never went to the target; a drop in the target's share is the sign of it.

### Browser mode

When the dashboard's server can't reach the proxy, the tests can run from your browser instead. The main case is a dashboard running on Datum Compute, which can't currently reach Datum's edge: every server-side test fails against a Datum proxy there.

**Automatic check.** When you enter or change the proxy URL, the dashboard asks its own server, through `/api/reach`, to send one request to that host (3s timeout). The answer is kept per host for the page's lifetime. If the server can reach it, tests stay on **Server**. If not, they switch to **Browser** with a note saying the server can't reach the host; on Datum Compute (the server can resolve `*.instances.datum.internal` names) the note says Datum Compute can't currently reach Datum's edge. Your own choice wins: switch back to Server any time, and a later reachable host only undoes the automatic switch, not one you made. `/api/reach` follows the same rules as `/api/probe` (public addresses only, 404 under `ORIGIN_ONLY`, behind `DASHBOARD_AUTH` when that's set) and reports only whether an answer came back and its status.

**What changes from the browser.** Requests go straight from your browser to the target, without cookies or a saved login, and timings and the client address are your machine's. The target is either on the dashboard's own origin (the proxy serving this dashboard), where everything is readable, or on another origin, where the browser reads a response only when it carries CORS headers. This tester's `/api/whoami` always does, and exposes every response header (`Access-Control-Expose-Headers: *`); an answer the proxy generates itself (a WAF block page, its own 504) doesn't. Per tab:

- **Headers & redirect.** Request headers are sent with fetch, so a browser's forbidden headers (`Cookie`, `Host`, `Origin`, `Referer`, `Sec-*`, `Proxy-*`, ...) can't be sent: those lines and presets are marked server only. The browser adds its own headers (User-Agent, Sec-Fetch-*, ...) that a page can't list, so the request comparison covers only the headers you set; everything the origin received is still listed below it, from `/api/whoami`'s echo. The response comparison covers what the browser can read: never `Set-Cookie` (the Cookies preset is server only), and from another origin, only what the origin exposes. There, the CORS preset is server only too, since it would replace the CORS headers the browser needs. The browser follows redirects itself, so the http to https check reports only where the request ended up, not the redirect's status, and an https page can't request `http://` at all. HSTS is read from the response headers.
- **WAF probes.** Same payloads, from the browser. From another origin a block page's status can't be read; when the request path is `/api/whoami` (the default), an attack that gets such an unreadable answer counts as blocked, and an unreadable benign answer (the home page, which sends no CORS headers) isn't judged.
- **Health checks** and **Timeouts & retries.** Same runs, with the browser's own timeouts. From another origin, an answer the proxy generates itself is recorded as *unreadable* and counted as the proxy's own error, since that's what the proxy sends in these tests (its 503 or its 504 at 15s). Keep the tab open while a run goes.

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

## Sticky failure

`?fail=` only affects the requests that carry it. Sometimes an origin has to stay broken for **every** request, including ones the tester doesn't send: a proxy's active health checks, real clients, another team's test. Sticky failure puts one instance in any of the failure modes above until it's reset, or until it resets itself.

It only exists behind a login (`DASHBOARD_AUTH`, see [Run on Datum Compute](#run-on-datum-compute)). Without one, or with `ORIGIN_ONLY=1`, `/api/sticky-failure` returns 404 and no instance can be left broken, so a deployment that automated tests use without a login keeps its guarantee: every failure was asked for by the request that got it, and a run that's killed halfway leaves nothing behind.

| Request | Effect |
| --- | --- |
| `GET /api/sticky-failure` | Current state: `sticky` is `null`, or the mode with its parameters, `setAt`, `expiresAt` and `remainingS` |
| `POST /api/sticky-failure` | Set a mode. JSON body with the `?fail=` parameters (`failMode`, `failStatus`, `delayMs`, `jitterMin`, `jitterMax`, `failPercent`) and `ttlS` |
| `DELETE /api/sticky-failure` | Reset |

While a mode is set, the instance applies it to every request to `/api/whoami`, whether it came directly or through a proxy. A request whose `?fail=` names this instance or its backend still gets what the flags ask for instead. Failed responses carry `"sticky": true` in the body.

- **It resets itself** after `ttlS` seconds: 30 minutes by default, 24 hours at most, so a forgotten instance recovers on its own. A restart also resets it; the state is kept in memory only.
- **Reach the instance directly.** A command sent through a proxy lands on whichever instance the proxy picks. On Datum Compute, use the instance's internal name, `<workload>-<network>-<location>-<n>.instances.datum.internal:3000`, from inside the network, or the dashboard.
- It needs the login, takes changes only by `POST` and `DELETE`, sends no CORS headers, and refuses cross-site browser requests, so another site can't use a saved login to break an instance.
- An unknown `failMode` is refused (`?fail=` reads it as `error`), since a typo would last for the whole TTL.

```bash
# from inside the network: instance 1 answers 503 for 10 minutes
curl -u user:password -X POST -H 'Content-Type: application/json'   -d '{"failMode":"error","failStatus":503,"ttlS":600}'   http://alb-lb-tester-default-us-east-1-1.instances.datum.internal:3000/api/sticky-failure

curl -u user:password http://alb-lb-tester-default-us-east-1-1.instances.datum.internal:3000/api/sticky-failure
curl -u user:password -X DELETE http://alb-lb-tester-default-us-east-1-1.instances.datum.internal:3000/api/sticky-failure
```

The **Sticky failure** tab drives this from the dashboard. Enter the workload's `<workload>-<network>-<location>` and its instance count, and each instance gets **Check**, **Break** (with the mode, parameters and TTL from the form) and **Reset**. The dashboard's server sends the commands to each instance by internal name, with your login, so every instance of the workload must have the same `DASHBOARD_AUTH`. Only `*.datum.internal` names are accepted (any host under `next dev` or `ALLOW_PRIVATE_TARGETS=1`, for testing locally, for example `localhost:3001`).

**Which to use:** per-request flags when only your own test traffic should fail. They work through the proxy, need no login, and leave nothing behind. Sticky failure when the origin has to look broken to everyone, for example to watch active health checks eject it, or to see what real clients get.

## Headers

`/api/whoami` echoes the request headers it received in `headers` (`headersRaw: true` when they're exactly as they arrived), and lists the response headers it sent in `sentHeaders`. Ask it to send more with an `X-LBT-Resp-Header: Name: Value` request header, or numbered `X-LBT-Resp-Header-1`, `-2`, ... for several (a client may join repeats of one header name with commas, and a `Set-Cookie` value can contain commas). One with the same name as the origin's own header replaces it. Up to 20 headers of up to 1024 characters each. Framing and connection headers (`Content-Length`, `Content-Type`, `Transfer-Encoding`, `Connection`, ...) are refused and listed in `rejectedRespHeaders`. The `X-LBT-Resp-Header` headers are left out of the `headers` echo.

They're asked for in request headers, not the URL, so a link, redirect or cross-site form can't make the origin set cookies or redirect in someone's browser. The old `respHeader=` query parameter is refused.

```bash
# what does the edge do to a client's X-Forwarded-For?
curl -s -H "X-Forwarded-For: 203.0.113.7" "https://<proxy>/api/whoami" | jq .headers

# do both cookies and the Server header reach the client?
curl -s -D - -o /dev/null "https://<proxy>/api/whoami"   -H "X-LBT-Resp-Header-1: Server: my-app"   -H "X-LBT-Resp-Header-2: Set-Cookie: a=1"   -H "X-LBT-Resp-Header-3: Set-Cookie: b=2"
```

## Run on Datum Compute

The **Compute image** workflow builds `Dockerfile.datum` on every push to `main` that touches the app and publishes `ghcr.io/datum-labs/alb-lb-tester:container-latest` and `:container-sha-<commit>`. The final stage is distroless Node (no shell) running Next's standalone server. Run it on Compute's general-purpose runtime with **3 instances**, port `http` on **3000**, and environment `BACKEND_ID=compute`:

```bash
datumctl compute deploy alb-lb-tester --image ghcr.io/datum-labs/alb-lb-tester:container-latest   --runtime-class general-purpose --location us-east-1 --min 3 --http-port 3000 --env BACKEND_ID=compute
```

Compute keeps running the image it already pulled for an unchanged tag, so to move an existing workload to a newer build, deploy it again with that build's `container-sha-<commit>` tag.

The server binds `::` because Compute instances only have IPv6 addresses; an image built before that fix needs `--env HOSTNAME=::`. Each instance picks its own id at start; set `INSTANCE_ID` to name them yourself. A deployment that only needs to be an origin, such as one behind a proxy that automated tests use, can set `ORIGIN_ONLY=1`: `/api/whoami` keeps answering, and the dashboard, `/api/inspect`, `/api/probe`, `/api/reach` and `/api/sticky-failure` return 404, so it doesn't expose public server-side fetch tools nobody there uses. The repository and its package are public, so the workload needs no image pull secret. A project without a network named `default` needs `--network <name> --yes`, which creates one.

To put the dashboard behind a login, set `DASHBOARD_AUTH=user:password`. The dashboard, `/api/inspect`, `/api/probe` and `/api/reach` then need HTTP basic auth, and the inspector and probe may also reach `*.datum.internal` names, so a test can hit one instance directly. The login also turns on [sticky failure](#sticky-failure). `/api/whoami` stays open, since proxies, health checks and automated tests call it. The tools only take requests from the dashboard's own pages or from clients like curl, so another site can't use your saved login.

### Other ways to run the image

The `container-*` images run anywhere a container does:

```bash
docker run -p 3000:3000 -e BACKEND_ID=local ghcr.io/datum-labs/alb-lb-tester:container-latest
```

The workflow also publishes unikernel images, `:latest` and `:sha-<commit>`, built with `datumctl compute build --analyze`. They run only on Compute's default unikernel runtime, and the container images on the general-purpose runtime are the tested path.

## Notes

- The echo endpoint sends permissive CORS headers so the browser can read responses through the proxy, including every response header but `Set-Cookie` (`Access-Control-Expose-Headers: *`). It never pairs them with credentials.
- A dashboard on Datum Compute can't currently reach Datum's edge, so the server-side tests can't reach a Datum proxy from there; the dashboard notices and switches to [browser mode](#browser-mode).
- Responses set `Cache-Control: no-store` and the dashboard adds a cache-buster, so every request reaches an origin.
- The distribution counts each backend by the `backendId` in its response, so a warm serverless instance and a cold one under the same `BACKEND_ID` still count as one backend, which is what you want when reasoning about the proxy's routing.

## Local development

Built with Next.js 16, React 19, Tailwind v4, and the @datum-cloud/datum-ui design system.

```bash
npm ci
npm run dev
# open http://localhost:3000
```
