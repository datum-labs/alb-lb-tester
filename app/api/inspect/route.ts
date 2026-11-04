import { NextRequest, NextResponse } from 'next/server';
import { foldHeaders, headersObject, parseHeaderLines } from '../../header-diff';

// Server-side inspector: fetches the target from the serverless runtime, so it
// can read response headers (HSTS, x-envoy-*) and redirects that the browser's
// CORS rules hide from the dashboard.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Sent on every inspection. The runtime's fetch adds these itself when
// they're missing, so setting them makes the list of what was sent complete:
// anything else the origin receives was added on the way.
const BASE_REQUEST_HEADERS: [string, string][] = [
  ['accept', 'application/json'],
  ['accept-encoding', 'identity'],
  ['accept-language', '*'],
  ['cache-control', 'no-cache'],
  ['pragma', 'no-cache'],
  ['sec-fetch-mode', 'cors'],
  ['user-agent', 'alb-lb-tester-inspect'],
];

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

  // Extra request headers to send, `?h=Name:Value` (repeatable): spoofed
  // forwarding headers and the like, to see what reaches the origin.
  const { headers: custom, rejected } = parseHeaderLines(req.nextUrl.searchParams.getAll('h'));
  const customNames = new Set(custom.map(([k]) => k));
  const sentPairs = [...BASE_REQUEST_HEADERS.filter(([k]) => !customNames.has(k)), ...custom];
  const sendHeaders = new Headers();
  for (const [k, v] of sentPairs) sendHeaders.append(k, v);
  const requestSent = { host: parsed.host, ...foldHeaders(sentPairs) };
  if (rejected.length) result.rejectedRequestHeaders = rejected;

  // Main GET, following redirects, to read response headers + body.
  try {
    const { res, ms } = await timedFetch(target, { redirect: 'follow', headers: sendHeaders });
    const responseHeaders = headersObject(res.headers);
    let body: unknown = null;
    let requestHeadersSeen: Record<string, string> | null = null;
    let originSent: Record<string, string> | null = null;
    let rejectedRespHeaders: unknown = undefined;
    let originRuntimeHeaders: unknown = undefined;
    let originHeadersRaw: unknown = undefined;
    let backendId: string | null = res.headers.get('x-backend-id');
    try {
      const j = await res.json();
      body = j;
      if (j && typeof j === 'object') {
        if (typeof j.backendId === 'string') backendId = j.backendId;
        if (j.headers && typeof j.headers === 'object') requestHeadersSeen = j.headers;
        if (j.sentHeaders && typeof j.sentHeaders === 'object') originSent = j.sentHeaders;
        if (Array.isArray(j.rejectedRespHeaders)) rejectedRespHeaders = j.rejectedRespHeaders;
        if (Array.isArray(j.runtimeHeaders)) originRuntimeHeaders = j.runtimeHeaders;
        if (typeof j.headersRaw === 'boolean') originHeadersRaw = j.headersRaw;
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
      requestSent,
      requestHeadersSeen,
      originSent,
      responseHeaders,
      rejectedRespHeaders,
      originRuntimeHeaders,
      originHeadersRaw,
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
