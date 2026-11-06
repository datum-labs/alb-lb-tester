import { lookup, Resolver } from 'node:dns/promises';
import { hostname } from 'node:os';
import { NextRequest, NextResponse } from 'next/server';
import { originOnly } from '../../origin-only';
import { describeError, parseTarget, safeFetch } from '../../safe-fetch';

// Can this dashboard's server reach the proxy? The dashboard asks once per
// host when the proxy URL changes, and runs the tests from the browser when
// the answer is no (a dashboard on Datum Compute can't reach Datum's edge).
// It sends one GET to the host's root through the same safeFetch as the
// probe, with the same address rules, and answers only whether a response
// came back and its status: less than /api/probe already tells.
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const TIMEOUT_MS = 3000;
const DNS_TIMEOUT_MS = 1500;
const INSTANCES = 'instances.datum.internal';

let compute: Promise<boolean> | null = null;

/**
 * True when this server runs on Datum Compute, judged by whether it can
 * resolve names under instances.datum.internal. `.internal` is reserved and
 * never resolves on the public internet, so only Compute's own resolver
 * answers for it. Tries this instance's own name and the zone itself; checked
 * once per process.
 */
function onCompute(): Promise<boolean> {
  compute ??= (async () => {
    const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
    const host = hostname();
    const checks = [
      resolver.resolveSoa(INSTANCES),
      ...(host && !host.includes('.') ? [lookup(`${host}.${INSTANCES}`)] : []),
    ];
    const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), DNS_TIMEOUT_MS + 200));
    try {
      await Promise.race([Promise.any(checks), timeout]);
      return true;
    } catch {
      return false;
    }
  })();
  return compute;
}

export async function GET(req: NextRequest) {
  if (originOnly) return new NextResponse(null, { status: 404 });
  const target = req.nextUrl.searchParams.get('url');
  if (!target) return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  let url: URL;
  try {
    url = parseTarget(target);
  } catch (e) {
    return NextResponse.json({ error: `Invalid url: ${e instanceof Error ? e.message : e}` }, { status: 400 });
  }

  const computeCheck = onCompute();
  const t0 = Date.now();
  let result: { reachable: boolean; status?: number; error?: string };
  try {
    // Any answer counts, an error status included: the host is reachable.
    const res = await safeFetch(`${url.origin}/`, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    await res.body?.cancel();
    result = { reachable: true, status: res.status };
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    result = { reachable: false, error: timedOut ? `no answer within ${TIMEOUT_MS / 1000}s` : describeError(e) };
  }
  return NextResponse.json(
    { host: url.host, ...result, ms: Date.now() - t0, onCompute: await computeCheck },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
