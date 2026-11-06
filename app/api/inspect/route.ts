import { NextRequest, NextResponse } from 'next/server';
import { foldHeaders, headersObject, parseHeaderLines, RESP_HEADER } from '../../header-diff';
import { originOnly } from '../../origin-only';
import { describeError, parseTarget, safeFetch } from '../../safe-fetch';

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

// The whole inspection has to finish inside the edge's own 15s limit when the
// dashboard runs behind a proxy, or the edge answers 504 with an HTML page
// instead of this route's JSON. Both requests run at once and share this
// budget, which also covers reading the body.
const BUDGET_MS = 11_000;

async function timedFetch(url: string, init: Parameters<typeof safeFetch>[1], signal: AbortSignal) {
  const t0 = Date.now();
  const res = await safeFetch(url, { ...init, signal });
  return { res, ms: Date.now() - t0 };
}

/** The error for a request, naming the target when it ran out of time. */
function failure(e: unknown, url: string, signal: AbortSignal): string {
  if (signal.aborted) return `No answer from ${new URL(url).host} within ${BUDGET_MS / 1000}s`;
  return describeError(e);
}

export async function GET(req: NextRequest) {
  if (originOnly) return new NextResponse(null, { status: 404 });
  const target = req.nextUrl.searchParams.get('url');
  if (!target) {
    return NextResponse.json({ error: 'Missing url parameter' }, { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = parseTarget(target);
  } catch (e) {
    return NextResponse.json({ error: `Invalid URL: ${e instanceof Error ? e.message : e}` }, { status: 400 });
  }

  const result: Record<string, unknown> = {};

  // Extra request headers to send, `?h=Name:Value` (repeatable): spoofed
  // forwarding headers and the like, to see what reaches the origin.
  const { headers: custom, rejected } = parseHeaderLines(req.nextUrl.searchParams.getAll('h'));
  const customNames = new Set(custom.map(([k]) => k));
  const sentPairs = [...BASE_REQUEST_HEADERS.filter(([k]) => !customNames.has(k)), ...custom];
  const sendHeaders = new Headers();
  for (const [k, v] of sentPairs) sendHeaders.append(k, v);
  // Headers asking the origin for response headers are left out, as the
  // origin leaves them out of its echo: they aren't what's being compared.
  const requestSent = { host: parsed.host, ...foldHeaders(sentPairs.filter(([k]) => !RESP_HEADER.test(k))) };
  if (rejected.length) result.rejectedRequestHeaders = rejected;

  const signal = AbortSignal.timeout(BUDGET_MS);

  // Main GET, following redirects, to read response headers + body.
  async function inspect() {
    try {
      const { res, ms } = await timedFetch(target!, { redirect: 'follow', headers: sendHeaders }, signal);
      const responseHeaders = headersObject(res.headers);
      let requestHeadersSeen: Record<string, string> | null = null;
      let originSent: Record<string, string> | null = null;
      let rejectedRespHeaders: unknown = undefined;
      let originRuntimeHeaders: unknown = undefined;
      let originHeadersRaw: unknown = undefined;
      let backendId: string | null = res.headers.get('x-backend-id');
      try {
        const j = (await res.json()) as any;
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
      return {
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
      return { error: failure(e, target!, signal) };
    }
  }

  // Redirect probe: hit the http:// variant with manual redirect handling.
  const httpUrl = `http://${parsed.host}${parsed.pathname}${parsed.search}`;
  async function redirect() {
    try {
      const { res, ms } = await timedFetch(httpUrl, { redirect: 'manual' }, signal);
      await res.body?.cancel();
      return {
        from: httpUrl,
        status: res.status,
        location: res.headers.get('location'),
        redirected: res.status >= 300 && res.status < 400,
        ms,
      };
    } catch (e) {
      return { from: httpUrl, error: failure(e, httpUrl, signal) };
    }
  }

  [result.get, result.redirect] = await Promise.all([inspect(), redirect()]);

  return NextResponse.json(result, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
