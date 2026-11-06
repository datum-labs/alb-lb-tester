import { NextRequest, NextResponse } from 'next/server';
import { failureSpec, MAX_HANG_MS, rollFailure, type Failure } from '../../failure';
import { foldHeaders, parseHeaderLines, RESP_HEADER } from '../../header-diff';
import { backendId, currentSticky, instanceId } from '../../instance';

// Always run per-request; never cache. Load balancing is only observable if
// every request actually reaches an origin.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const coldStartAt = new Date().toISOString();
let requestCount = 0;

// The dashboard's browser mode reads these responses from other origins, and
// its Headers tab compares every response header it can: `*` exposes them
// all (except Set-Cookie, which a browser never reveals) to requests without
// credentials, the only kind this origin answers cross-site. The names stay
// listed for browsers that don't take the wildcard.
const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*, x-backend-id, x-instance-id, x-fail-mode',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

/**
 * Failure injection for health-check testing. `?fail=backend-b` (a
 * comma-separated list, or `*` for every backend) makes the named backend
 * misbehave instead of answering normally. A name can also be an instance id,
 * which fails just that instance: one endpoint of a backend with several, the
 * case outlier detection acts on. It's per request and stateless, so it works
 * through the proxy: only requests that carry it fail, and only where the
 * name matches.
 *
 * `?failMode` picks how it misbehaves:
 *   error   (default) answer `?failStatus` (5xx, default 503)
 *   delay   answer 200 after `?delayMs` (default 1000)
 *   jitter  answer 200 after a random delay in `?jitterMin`..`?jitterMax` (default 100..2000)
 *   hang    never answer, to exercise the proxy's timeout
 * `?failPercent` (0-100, default 100) applies it to only that share of
 * matching requests; the rest answer normally, like a flaky-not-dead origin.
 *
 * A request without a matching `?fail=` gets this instance's sticky failure,
 * if one is set (see /api/sticky-failure).
 */
function failureFor(url: URL, id: string): Failure | null {
  const fail = url.searchParams.get('fail');
  if (!fail) return null;
  const targets = fail.split(',').map((s) => s.trim());
  if (!targets.includes('*') && !targets.includes(id) && !targets.includes(instanceId)) return null;
  return rollFailure(failureSpec(url.searchParams));
}

// Waits `ms`, or until the client goes away, whichever comes first.
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** The response headers asked for, in order. */
function askedRespHeaders(pairs: [string, string][]): string[] {
  return pairs
    .map(([k, v], i) => {
      const m = RESP_HEADER.exec(k.toLowerCase());
      return m && { n: m[1] === undefined ? 0 : Number(m[1]), i, v };
    })
    .filter((x) => x !== null)
    .sort((a, b) => a.n - b.n || a.i - b.i)
    .map((x) => x.v);
}

/**
 * Response headers asked for with X-LBT-Resp-Header request headers, so a
 * test can see what the edge does to headers an origin sends: Server,
 * Set-Cookie, Cache-Control, CORS and so on. They replace this origin's own
 * header of the same name. Framing and connection headers are refused, and
 * the count and length are capped.
 *
 * They're asked for in request headers, not the URL, so that a link, a
 * redirect or a cross-site form can't make this origin set cookies or
 * redirect in a visitor's browser: none of those can add request headers.
 * The old `?respHeader=` is refused for that reason.
 */
function responseHeaders(url: URL, asked: string[], own: Record<string, string>) {
  const { headers: custom, rejected } = parseHeaderLines(asked);
  for (const line of url.searchParams.getAll('respHeader')) {
    rejected.push({ line, reason: 'respHeader= is no longer read; send X-LBT-Resp-Header request headers instead' });
  }
  const replaced = new Set(custom.map(([k]) => k));
  const pairs: [string, string][] = [
    ['content-type', 'application/json'],
    ...Object.entries(own).map(([k, v]) => [k.toLowerCase(), v] as [string, string]).filter(([k]) => !replaced.has(k)),
    ...custom,
  ];
  const headers = new Headers();
  for (const [k, v] of pairs) headers.append(k, v);
  // What this origin sends, folded the way the client will see it, so the
  // dashboard can compare. The runtime adds framing headers (Date,
  // Content-Length, ...) after this point.
  return { headers, sent: foldHeaders(pairs), rejected };
}

function json(body: Record<string, unknown>, status: number, url: URL, asked: string[], own: Record<string, string>) {
  const { headers, sent, rejected } = responseHeaders(url, asked, own);
  const full = {
    ...body,
    sentHeaders: sent,
    // Added by Next after the handler returns (it appends Vary to every
    // response), so they're not in sentHeaders.
    runtimeHeaders: ['vary'],
    ...(rejected.length && { rejectedRespHeaders: rejected }),
  };
  return new NextResponse(JSON.stringify(full), { status, headers });
}

// A CORS preflight. It must never set the asked-for response headers, and
// never pair a reflected Origin with Access-Control-Allow-Credentials: that's
// what keeps a cross-site page from using X-LBT-Resp-Header to set cookies.
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

/**
 * The request headers as they arrived. With raw-headers.cjs preloaded (the
 * Datum Compute image) that's the raw list from the socket; without it, it's
 * what Next passes on, which may include X-Forwarded-* headers Next filled in
 * itself.
 */
function receivedHeaders(req: NextRequest): { pairs: [string, string][]; raw: boolean } {
  const stamped = req.headers.get('x-lbt-received');
  if (stamped) {
    try {
      const pairs = JSON.parse(Buffer.from(stamped, 'base64').toString('utf8')) as [string, string][];
      return { pairs, raw: true };
    } catch {
      /* fall through */
    }
  }
  return { pairs: [...req.headers.entries()].filter(([k]) => k !== 'x-lbt-received'), raw: false };
}

async function handle(req: NextRequest) {
  requestCount += 1;
  const { pairs, raw } = receivedHeaders(req);
  const asked = askedRespHeaders(pairs);
  // The echo leaves out the headers that asked for response headers: they're
  // instructions to this origin, not something the edge did.
  const headers = foldHeaders(pairs.filter(([k]) => !RESP_HEADER.test(k.toLowerCase())));
  const id = backendId();
  const url = new URL(req.url);
  const flagged = failureFor(url, id);
  const sticky = flagged ? null : currentSticky();
  const failure = flagged ?? (sticky && rollFailure(sticky.spec));
  const idHeaders = { ...corsHeaders, 'x-backend-id': id, 'x-instance-id': instanceId };
  // Marks a failure that came from the sticky mode, not from this request's flags.
  const stickyField = failure && sticky ? { sticky: true } : {};

  if (failure?.mode === 'error') {
    return json(
      { backendId: id, instanceId, failed: true, failMode: 'error', status: failure.status, ...stickyField, servedAt: new Date().toISOString() },
      failure.status, url, asked, { ...idHeaders, 'x-fail-mode': 'error' },
    );
  }

  if (failure?.mode === 'hang') {
    // Hold the request open without answering. If the client or proxy gives
    // up first there's no one left to answer; past the cap, close it with a
    // 504 so the instance doesn't collect stuck requests.
    await wait(MAX_HANG_MS, req.signal);
    return json(
      { backendId: id, instanceId, failed: true, failMode: 'hang', ...stickyField, servedAt: new Date().toISOString() },
      504, url, asked, { ...idHeaders, 'x-fail-mode': 'hang' },
    );
  }

  if (failure) await wait(failure.delayMs, req.signal);

  const body = {
    backendId: id,
    instanceId,
    requestCountThisInstance: requestCount,
    coldStartAt,
    servedAt: new Date().toISOString(),
    region: process.env.VERCEL_REGION ?? null,
    clientIp:
      headers['x-forwarded-for']?.split(',')[0]?.trim() ??
      headers['x-real-ip'] ??
      null,
    hostHeader: headers['host'] ?? null,
    forwardedHost: headers['x-forwarded-host'] ?? null,
    lbKey: headers['x-lb-key'] ?? null,
    method: req.method,
    path: url.pathname,
    // Present only when a delay or jitter was applied to this request.
    ...(failure && { failMode: failure.mode, delayedMs: failure.delayMs, ...stickyField }),
    headers,
    // false: headers are as Next passed them on, not as they arrived.
    headersRaw: raw,
  };

  return json(body, 200, url, asked, failure ? { ...idHeaders, 'x-fail-mode': failure.mode } : idHeaders);
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
