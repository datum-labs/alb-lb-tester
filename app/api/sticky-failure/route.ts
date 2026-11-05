import { NextRequest, NextResponse } from 'next/server';
import { INTERNAL_SUFFIX } from '../../dashboard-auth';
import { FAIL_MODES, failureSpec } from '../../failure';
import {
  backendId,
  clearSticky,
  currentSticky,
  DEFAULT_STICKY_TTL_S,
  instanceId,
  MAX_STICKY_TTL_S,
  setSticky,
  stickyAllowed,
  type Sticky,
} from '../../instance';
import { allowPrivate, describeError, safeFetch } from '../../safe-fetch';

// Sticky failure: puts this instance in a failure mode that applies to every
// /api/whoami request, flags or not, until it's reset or expires. For tests
// that need an origin to stay broken while traffic the tester doesn't send
// (a proxy's health checks, real clients) reaches it. A command sent through
// a proxy lands on whichever instance the proxy picks, so this is meant for
// reaching an instance directly.
//
//   GET     current state
//   POST    set a mode: JSON with the ?fail= parameters (failMode, failStatus,
//           delayMs, jitterMin, jitterMax, failPercent) and ttlS
//   DELETE  reset
//
// Only behind DASHBOARD_AUTH (proxy.ts asks for the login, and refuses
// cross-site browser requests); otherwise, and under ORIGIN_ONLY, it's a 404.
// State changes only by POST and DELETE, and there are no CORS headers, so
// another site can neither change nor read it.
//
// With ?instance=<host[:port]> the dashboard's server relays the command to
// that instance (port 3000 if none is given), forwarding the login, so the
// dashboard can drive each instance of its workload by internal name. Only
// *.datum.internal names, unless private targets are allowed (`next dev`,
// ALLOW_PRIVATE_TARGETS=1).
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const RELAY_TIMEOUT_MS = 10_000;
const NO_STORE = { 'Cache-Control': 'no-store' };

function describe(sticky: Sticky | null) {
  if (!sticky) return null;
  return {
    ...sticky.spec,
    setAt: new Date(sticky.setAt).toISOString(),
    expiresAt: new Date(sticky.expiresAt).toISOString(),
    remainingS: Math.max(0, Math.ceil((sticky.expiresAt - Date.now()) / 1000)),
  };
}

function state() {
  return NextResponse.json({ backendId: backendId(), instanceId, sticky: describe(currentSticky()) }, { headers: NO_STORE });
}

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400, headers: NO_STORE });
}

/** The sticky failure URL on another instance, or null for a host that isn't allowed. */
function relayUrl(instance: string): string | null {
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/i.test(instance)) return null;
  const url = new URL(`http://${instance}`);
  if (!allowPrivate && !url.hostname.endsWith(INTERNAL_SUFFIX)) return null;
  if (!url.port) url.port = '3000';
  url.pathname = '/api/sticky-failure';
  return url.toString();
}

async function relay(req: NextRequest, instance: string) {
  const url = relayUrl(instance);
  if (!url) return badRequest(`instance must be a *${INTERNAL_SUFFIX} name, with an optional :port`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const res = await safeFetch(url, {
      method: req.method,
      // Instances of one workload share DASHBOARD_AUTH, and proxy.ts has
      // already checked this login against it.
      headers: { authorization: req.headers.get('authorization') ?? '', 'content-type': 'application/json' },
      body: req.method === 'POST' ? await req.text() : undefined,
      redirect: 'manual',
      signal: ctrl.signal,
    });
    return new NextResponse(await res.text(), {
      status: res.status,
      headers: { ...NO_STORE, 'content-type': res.headers.get('content-type') ?? 'text/plain' },
    });
  } catch (e) {
    return NextResponse.json({ error: describeError(e) }, { status: 502, headers: NO_STORE });
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(req: NextRequest) {
  if (!stickyAllowed) return new NextResponse(null, { status: 404 });
  const instance = req.nextUrl.searchParams.get('instance');
  return instance ? relay(req, instance) : state();
}

export async function POST(req: NextRequest) {
  if (!stickyAllowed) return new NextResponse(null, { status: 404 });
  const instance = req.nextUrl.searchParams.get('instance');
  if (instance) return relay(req, instance);

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest('Send the mode as a JSON object');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest('Send the mode as a JSON object');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (typeof v === 'string' || typeof v === 'number') params.set(k, String(v));
  }
  // ?fail= reads an unknown mode as error; a typo here would last for the
  // whole TTL, so it's refused instead.
  const mode = params.get('failMode');
  if (mode !== null && !(FAIL_MODES as readonly string[]).includes(mode)) {
    return badRequest(`failMode must be one of ${FAIL_MODES.join(', ')}`);
  }
  const ttl = Number(params.get('ttlS') ?? DEFAULT_STICKY_TTL_S);
  if (!Number.isFinite(ttl)) return badRequest('ttlS must be a number of seconds');
  const ttlS = Math.min(MAX_STICKY_TTL_S, Math.max(1, Math.round(ttl)));

  setSticky(failureSpec(params), ttlS);
  return state();
}

export async function DELETE(req: NextRequest) {
  if (!stickyAllowed) return new NextResponse(null, { status: 404 });
  const instance = req.nextUrl.searchParams.get('instance');
  if (instance) return relay(req, instance);
  clearSticky();
  return state();
}
