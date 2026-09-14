import { NextRequest, NextResponse } from 'next/server';

// Server-side single-request probe. Returns the real status code the proxy
// gave, which the browser cannot read for cross-origin responses that lack
// CORS headers (a WAF 403 block page, or a plain HTML 200).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url');
  if (!target) return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  try {
    new URL(target);
  } catch {
    return NextResponse.json({ error: 'Invalid url' }, { status: 400 });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const t0 = Date.now();
  try {
    const res = await fetch(target, { redirect: 'manual', cache: 'no-store', signal: ctrl.signal });
    return NextResponse.json(
      { status: res.status, ok: res.ok, ms: Date.now() - t0 },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    return NextResponse.json({ status: 0, ok: false, ms: Date.now() - t0, error: String(e) });
  } finally {
    clearTimeout(timer);
  }
}
