import { NextRequest, NextResponse } from 'next/server';

// Always run per-request; never cache. Load balancing is only observable if
// every request actually reaches an origin.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Per-instance identity. A warm serverless instance keeps these across
// requests; a cold start resets them. Useful for spotting round-robin /
// least-request behaviour landing on the same instance. On Datum Compute each
// instance is one of the backend's endpoints, so this is also what the health
// check test fails when it targets a single endpoint. INSTANCE_ID overrides it.
const instanceId = process.env.INSTANCE_ID || Math.random().toString(36).slice(2, 8);
const coldStartAt = new Date().toISOString();
let requestCount = 0;

function backendId(): string {
  if (process.env.BACKEND_ID) return process.env.BACKEND_ID;
  // Fall back to the Vercel deployment host so multiple deploys are still
  // distinguishable without setting BACKEND_ID.
  if (process.env.VERCEL_URL) return process.env.VERCEL_URL.split('.')[0];
  return 'local';
}

const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'x-backend-id, x-instance-id, x-fail-mode',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

// Longest a delay may be asked for, and how long a hang holds a request
// before giving up on it, so a forgotten client can't pin an instance forever.
const MAX_DELAY_MS = 60_000;
const MAX_HANG_MS = 10 * 60_000;

type Failure =
  | { mode: 'error'; status: number }
  | { mode: 'delay' | 'jitter'; delayMs: number }
  | { mode: 'hang' };

function intParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const n = Number(url.searchParams.get(name) ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

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
 */
function failureFor(url: URL, id: string): Failure | null {
  const fail = url.searchParams.get('fail');
  if (!fail) return null;
  const targets = fail.split(',').map((s) => s.trim());
  if (!targets.includes('*') && !targets.includes(id) && !targets.includes(instanceId)) return null;

  const percent = intParam(url, 'failPercent', 100, 0, 100);
  if (Math.random() * 100 >= percent) return null;

  switch (url.searchParams.get('failMode')) {
    case 'delay':
      return { mode: 'delay', delayMs: intParam(url, 'delayMs', 1000, 0, MAX_DELAY_MS) };
    case 'jitter': {
      const min = intParam(url, 'jitterMin', 100, 0, MAX_DELAY_MS);
      const max = Math.max(min, intParam(url, 'jitterMax', 2000, 0, MAX_DELAY_MS));
      return { mode: 'jitter', delayMs: Math.floor(min + Math.random() * (max - min)) };
    }
    case 'hang':
      return { mode: 'hang' };
    default: {
      const requested = Number(url.searchParams.get('failStatus') ?? 503);
      const status = Number.isInteger(requested) && requested >= 500 && requested <= 599 ? requested : 503;
      return { mode: 'error', status };
    }
  }
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

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function handle(req: NextRequest) {
  requestCount += 1;
  const headers = Object.fromEntries(req.headers.entries());
  const id = backendId();
  const url = new URL(req.url);
  const failure = failureFor(url, id);
  const idHeaders = { ...corsHeaders, 'x-backend-id': id, 'x-instance-id': instanceId };

  if (failure?.mode === 'error') {
    return NextResponse.json(
      { backendId: id, instanceId, failed: true, failMode: 'error', status: failure.status, servedAt: new Date().toISOString() },
      { status: failure.status, headers: { ...idHeaders, 'x-fail-mode': 'error' } },
    );
  }

  if (failure?.mode === 'hang') {
    // Hold the request open without answering. If the client or proxy gives
    // up first there's no one left to answer; past the cap, close it with a
    // 504 so the instance doesn't collect stuck requests.
    await wait(MAX_HANG_MS, req.signal);
    return NextResponse.json(
      { backendId: id, instanceId, failed: true, failMode: 'hang', servedAt: new Date().toISOString() },
      { status: 504, headers: { ...idHeaders, 'x-fail-mode': 'hang' } },
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
    ...(failure && { failMode: failure.mode, delayedMs: failure.delayMs }),
    headers,
  };

  return NextResponse.json(body, {
    headers: failure ? { ...idHeaders, 'x-fail-mode': failure.mode } : idHeaders,
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
