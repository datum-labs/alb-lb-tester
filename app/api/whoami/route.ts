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
  'Access-Control-Expose-Headers': 'x-backend-id, x-instance-id',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

/**
 * Failure injection for health-check testing. `?fail=backend-b` (a
 * comma-separated list, or `*` for every backend) makes the named backend
 * answer with `?failStatus` (default 503) instead of 200. A name can also be
 * an instance id, which fails just that instance: one endpoint of a backend
 * with several, the case outlier detection acts on. It's per request and
 * stateless, so it works through the proxy: only requests that carry it
 * fail, and only where the name matches.
 */
function failureFor(url: URL, id: string): number | null {
  const fail = url.searchParams.get('fail');
  if (!fail) return null;
  const targets = fail.split(',').map((s) => s.trim());
  if (!targets.includes('*') && !targets.includes(id) && !targets.includes(instanceId)) return null;
  const requested = Number(url.searchParams.get('failStatus') ?? 503);
  return Number.isInteger(requested) && requested >= 500 && requested <= 599 ? requested : 503;
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function handle(req: NextRequest) {
  requestCount += 1;
  const headers = Object.fromEntries(req.headers.entries());
  const id = backendId();
  const url = new URL(req.url);
  const failStatus = failureFor(url, id);

  if (failStatus !== null) {
    return NextResponse.json(
      { backendId: id, instanceId, failed: true, status: failStatus, servedAt: new Date().toISOString() },
      { status: failStatus, headers: { ...corsHeaders, 'x-backend-id': id, 'x-instance-id': instanceId } },
    );
  }

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
    headers,
  };

  return NextResponse.json(body, {
    headers: { ...corsHeaders, 'x-backend-id': id, 'x-instance-id': instanceId },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
