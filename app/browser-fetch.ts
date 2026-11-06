/**
 * Browser mode: the dashboard's tests send their requests from the browser
 * instead of through the dashboard's server, for when that server can't reach
 * the proxy (a dashboard on Datum Compute can't reach Datum's edge).
 *
 * A browser is a more limited client than the server: it won't send some
 * headers, can't read Set-Cookie, and can read a cross-origin response only
 * when it carries CORS headers. This tester's /api/whoami always does, so its
 * answers are readable; one the proxy generates itself (a WAF block page, its
 * own 504) isn't.
 */

export type Via = 'server' | 'browser';

/**
 * Reads a dashboard API response as JSON. When something in front of the
 * dashboard answered instead (an edge's 504 HTML page), says so rather than
 * failing with a JSON parse error.
 */
export async function apiJson(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`The dashboard's server answered HTTP ${res.status} (not JSON)`);
  }
}

/** The message of a caught error, without the "Error: " prefix. */
export const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The status recorded for an answer the browser got but couldn't read: a
 * cross-origin response without CORS headers. This tester's origin always
 * sends them, so the proxy answered itself. It's above 500, so the health and
 * timeout analyses count it as the proxy's own error, which is what a proxy
 * sends in those tests (a 503 or a 504).
 */
export const UNREADABLE = 999;

export const statusLabel = (status: number) => (status === UNREADABLE ? 'unreadable' : String(status));

// Request headers a page can't set (the Fetch standard's forbidden request
// headers); fetch drops them silently, so they're refused up front instead.
const FORBIDDEN = new Set([
  'accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
  'connection', 'content-length', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host', 'keep-alive',
  'origin', 'referer', 'set-cookie', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'via',
  'x-http-method', 'x-http-method-override', 'x-method-override',
]);

export function forbiddenHeader(name: string): boolean {
  const n = name.toLowerCase();
  return FORBIDDEN.has(n) || n.startsWith('proxy-') || n.startsWith('sec-');
}

export function isCrossOrigin(url: string): boolean {
  try {
    return new URL(url).origin !== window.location.origin;
  } catch {
    return true;
  }
}

/** An https page can't request http:// URLs (mixed content). */
export function blockedAsMixedContent(url: string): boolean {
  return window.location.protocol === 'https:' && url.startsWith('http:');
}

export type BrowserResult = {
  /** The response, when the browser could read it. */
  res: Response | null;
  /** 0 when nothing came back in time; UNREADABLE for an answer without CORS headers. */
  status: number;
  ms: number;
  error?: string;
};

// When each origin last answered a no-cors check, so a run of unreadable
// answers doesn't check every time.
const answered = new Map<string, number>();

/**
 * Does the host answer at all? A no-cors request gets an opaque response
 * whatever headers come back, so it fails only when nothing does.
 */
async function hostAnswers(url: string): Promise<boolean> {
  const { origin } = new URL(url);
  if (Date.now() - (answered.get(origin) ?? 0) < 5000) return true;
  try {
    await fetch(`${origin}/api/whoami?_=reach`, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(5000) });
    answered.set(origin, Date.now());
    return true;
  } catch {
    return false;
  }
}

/**
 * One test request from the browser. It never sends credentials (cookies, a
 * saved login) or stores cookies, and gives up after timeoutMs. A
 * cross-origin answer without CORS headers fails the same way a dead host
 * does, so when one fails, a no-cors request to the host tells them apart.
 */
export async function browserFetch(url: string, opts: { headers?: HeadersInit; timeoutMs?: number } = {}): Promise<BrowserResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  if (blockedAsMixedContent(url)) {
    return { res: null, status: 0, ms: 0, error: 'An https page can\'t request http:// URLs; use the https URL' };
  }
  const signal = AbortSignal.timeout(timeoutMs);
  const t0 = performance.now();
  try {
    const res = await fetch(url, { headers: opts.headers, cache: 'no-store', credentials: 'omit', redirect: 'follow', signal });
    return { res, status: res.status, ms: performance.now() - t0 };
  } catch (e) {
    const ms = performance.now() - t0;
    if (signal.aborted) return { res: null, status: 0, ms, error: `No answer within ${timeoutMs / 1000}s` };
    if (isCrossOrigin(url) && (await hostAnswers(url))) {
      return { res: null, status: UNREADABLE, ms, error: 'The answer had no CORS headers, so the browser can\'t read it (the proxy answered itself, or the target isn\'t this tester\'s /api/whoami)' };
    }
    return { res: null, status: 0, ms, error: `Network error: ${messageOf(e)}` };
  }
}

/** Which of our origins answered, from its headers or its JSON body. */
export async function originOf(res: Response): Promise<{ backendId: string | null; instanceId: string | null; body: any }> {
  let backendId = res.headers.get('x-backend-id');
  let instanceId = res.headers.get('x-instance-id');
  let body: any = null;
  try {
    body = await res.json();
    if (body && typeof body.backendId === 'string') backendId = body.backendId;
    if (body && typeof body.instanceId === 'string') instanceId = body.instanceId;
  } catch {
    // Not one of our origins: no backend id.
  }
  return { backendId, instanceId, body };
}
