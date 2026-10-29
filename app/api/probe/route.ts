import { NextRequest, NextResponse } from 'next/server';

// Server-side single-request probe. Returns the real status code the proxy
// gave, which the browser cannot read for cross-origin responses that lack
// CORS headers (a WAF 403 block page, a plain HTML 200, or a 503 the proxy
// generates itself). Also reports which backend answered, when it was one of
// ours, so a proxy-generated error can be told apart from an origin's.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 100;

// Long enough for a normal request. The timeouts test raises it (?timeoutMs=)
// past the proxy's own timeout, so it sees the proxy give up, not the probe.
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_TIMEOUT_MS = 90_000;

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url');
  if (!target) return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  try {
    new URL(target);
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }
  const asked = Number(req.nextUrl.searchParams.get('timeoutMs'));
  const timeoutMs = asked > 0 ? Math.min(MAX_TIMEOUT_MS, Math.floor(asked)) : DEFAULT_TIMEOUT_MS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(target, { redirect: 'manual', cache: 'no-store', signal: ctrl.signal });
    let backendId = res.headers.get('x-backend-id');
    let instanceId = res.headers.get('x-instance-id');
    try {
      const body = await res.json();
      if (body && typeof body.backendId === 'string') backendId = body.backendId;
      if (body && typeof body.instanceId === 'string') instanceId = body.instanceId;
    } catch {
      // Not one of our origins (a WAF page, a proxy error): no backend id.
    }
    return NextResponse.json(
      { status: res.status, ok: res.ok, ms: Date.now() - t0, backendId, instanceId },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json({ status: 0, ok: false, ms: Date.now() - t0, backendId: null, instanceId: null, error: String(e) });
  } finally {
    clearTimeout(timer);
  }
}
