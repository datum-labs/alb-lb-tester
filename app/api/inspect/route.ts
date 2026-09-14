import { NextRequest, NextResponse } from 'next/server';

// Server-side inspector: fetches the target from the serverless runtime, so it
// can read response headers (HSTS, x-envoy-*) and redirects that the browser's
// CORS rules hide from the dashboard.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

async function timedFetch(url: string, init: RequestInit) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
    return { res, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  const target = req.nextUrl.searchParams.get('url');
  if (!target) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
  }

  const result: Record<string, unknown> = {};

  // Main GET, following redirects, to read response headers + body.
  try {
    const { res, ms } = await timedFetch(target, { redirect: 'follow' });
    const responseHeaders = headersToObject(res.headers);
    let body: unknown = null;
    let requestHeadersSeen: Record<string, string> | null = null;
    let backendId: string | null = res.headers.get('x-backend-id');
    try {
      const j = await res.json();
      body = j;
      if (j && typeof j === 'object') {
        if (typeof j.backendId === 'string') backendId = j.backendId;
        if (j.headers && typeof j.headers === 'object') requestHeadersSeen = j.headers;
      }
    } catch {
      /* non-JSON body */
    }
    result.get = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      ms,
      finalUrl: res.url,
      backendId,
      responseHeaders,
      requestHeadersSeen,
    };
  } catch (e) {
    result.get = { error: String(e) };
  }

  // Redirect probe: hit the http:// variant with manual redirect handling.
  const httpUrl = `http://${parsed.host}${parsed.pathname}${parsed.search}`;
  try {
    const { res, ms } = await timedFetch(httpUrl, { redirect: 'manual' });
    result.redirect = {
      from: httpUrl,
      status: res.status,
      location: res.headers.get('location'),
      redirected: res.status >= 300 && res.status < 400,
      ms,
    };
  } catch (e) {
    result.redirect = { from: httpUrl, error: String(e) };
  }

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
