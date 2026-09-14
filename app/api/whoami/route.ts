import { NextRequest, NextResponse } from 'next/server';

// Always run per-request; never cache. Load balancing is only observable if
// every request actually reaches an origin.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Per-instance identity. A warm serverless instance keeps these across
// requests; a cold start resets them. Useful for spotting round-robin /
// least-request behaviour landing on the same instance.
const instanceId = Math.random().toString(36).slice(2, 8);
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
  'Access-Control-Expose-Headers': 'x-backend-id',
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

function handle(req: NextRequest) {
  requestCount += 1;
  const headers = Object.fromEntries(req.headers.entries());
  const id = backendId();

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
    path: new URL(req.url).pathname,
    headers,
  };

  return NextResponse.json(body, {
    headers: { ...corsHeaders, 'x-backend-id': id },
  });
}

export async function GET(req: NextRequest) {
  return handle(req);
}

export async function POST(req: NextRequest) {
  return handle(req);
}
