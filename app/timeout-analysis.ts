/**
 * Analysis for the timeouts & retries test.
 *
 * A run sends a steady stream of requests in two phases:
 *   baseline — nothing misbehaves; measures normal latency and the target's share
 *   slow     — requests carry ?fail=<target>&failMode=…, so only the target is
 *              slow, hangs or errors
 *
 * Every endpoint gets the same request and only the target misbehaves, so each
 * slow-phase response says what the proxy did with it:
 *   - the target answered: the proxy waited for it, or passed its error on
 *   - another endpoint answered, but slowly: the proxy tried the target, gave
 *     up on it, and retried elsewhere
 *   - another endpoint answered at normal speed: the request never went to the
 *     target (or was retried at once, which timing can't tell apart)
 *   - no origin answered: the proxy gave up and returned its own error
 */

export type TimeoutPhase = 'baseline' | 'slow';

export type TimeoutSample = {
  n: number;
  /** ms since the run started, taken when the request was sent. */
  t: number;
  phase: TimeoutPhase;
  /** Which of our origins answered; null when the proxy answered itself. */
  backendId: string | null;
  instanceId: string | null;
  /** The backend id, or "<backend>·<instance>" within the target's backend. */
  unit: string | null;
  status: number;
  /** How long the request took, measured by the dashboard's server. */
  ms: number;
};

export type TimeoutOutcome =
  | 'ok'
  | 'waited'
  | 'retried'
  | 'origin-error'
  | 'proxy-error'
  | 'no-response'
  | 'other';

/**
 * Time over normal latency that marks a response from another endpoint as a
 * retry: the proxy spent it waiting on the target first. Well above jitter,
 * well below any timeout a proxy would use.
 */
export const RETRY_MARGIN_MS = 1000;

export function outcomeOf(sample: TimeoutSample, target: string, retryAfterMs: number): TimeoutOutcome {
  if (sample.status === 0) return 'no-response';
  if (!sample.backendId) return sample.status >= 500 ? 'proxy-error' : 'other';
  if (sample.status >= 500) return 'origin-error';
  if (sample.status >= 400) return 'other';
  if (sample.phase === 'baseline') return 'ok';
  if (sample.unit === target) return 'waited';
  return sample.ms >= retryAfterMs ? 'retried' : 'ok';
}

function quantile(values: number[], q: number): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

export type TimeoutVerdict = {
  baselineP50: number | null;
  baselineP95: number | null;
  /** Responses from other endpoints at least this slow count as retries. */
  retryAfterMs: number;
  baselineToTarget: number;
  baselineBackends: string[];
  /** Share of baseline requests the target served. */
  baselineShare: number;
  slowCount: number;
  /** Slow-phase outcomes. */
  counts: Record<TimeoutOutcome, number>;
  /** Slow-phase requests that went to the target: it answered, or the proxy gave up on it. */
  toTarget: number;
  targetShareSlow: number;
  /** Origin 5xx from the target itself, passed through by the proxy. */
  targetErrors: number;
  /** Statuses the proxy generated itself, most common first. */
  proxyStatuses: { status: number; count: number }[];
  /** How long the proxy waited before returning its own error. */
  proxyWaitMs: { p50: number; min: number; max: number } | null;
  /** How long a retried request took in all. */
  retriedMs: number | null;
  /** How long the proxy waited for a slow target that did answer. */
  waitedMs: number | null;
  achievedRate: Record<TimeoutPhase, number>;
};

export function analyse(
  samples: TimeoutSample[],
  target: string,
  baselineS: number,
  slowS: number,
): TimeoutVerdict {
  const baseline = samples.filter((s) => s.phase === 'baseline');
  const slow = samples.filter((s) => s.phase === 'slow');
  const baselineOk = baseline.filter((s) => s.backendId && s.status >= 200 && s.status < 400).map((s) => s.ms);
  const baselineP50 = quantile(baselineOk, 0.5);
  const baselineP95 = quantile(baselineOk, 0.95);
  const retryAfterMs = (baselineP95 ?? 0) + RETRY_MARGIN_MS;
  const baselineToTarget = baseline.filter((s) => s.unit === target).length;

  const counts: Record<TimeoutOutcome, number> = {
    ok: 0, waited: 0, retried: 0, 'origin-error': 0, 'proxy-error': 0, 'no-response': 0, other: 0,
  };
  const outcomes = slow.map((s) => ({ s, outcome: outcomeOf(s, target, retryAfterMs) }));
  for (const { outcome } of outcomes) counts[outcome] += 1;
  const msOf = (outcome: TimeoutOutcome) => outcomes.filter((o) => o.outcome === outcome).map((o) => o.s.ms);

  const targetErrors = outcomes.filter((o) => o.outcome === 'origin-error' && o.s.unit === target).length;
  const toTarget = counts.waited + counts.retried + counts['proxy-error'] + counts['no-response'] + targetErrors;

  const proxyByStatus = new Map<number, number>();
  for (const o of outcomes) {
    if (o.outcome === 'proxy-error') proxyByStatus.set(o.s.status, (proxyByStatus.get(o.s.status) ?? 0) + 1);
  }
  const proxyMs = msOf('proxy-error');

  return {
    baselineP50,
    baselineP95,
    retryAfterMs,
    baselineToTarget,
    baselineBackends: [...new Set(baseline.map((s) => s.unit).filter((id): id is string => !!id))],
    baselineShare: baseline.length ? baselineToTarget / baseline.length : 0,
    slowCount: slow.length,
    counts,
    toTarget,
    targetShareSlow: slow.length ? toTarget / slow.length : 0,
    targetErrors,
    proxyStatuses: [...proxyByStatus.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
    proxyWaitMs: proxyMs.length
      ? { p50: quantile(proxyMs, 0.5)!, min: Math.min(...proxyMs), max: Math.max(...proxyMs) }
      : null,
    retriedMs: quantile(msOf('retried'), 0.5),
    waitedMs: quantile(msOf('waited'), 0.5),
    achievedRate: {
      baseline: baseline.length / Math.max(1, baselineS),
      slow: slow.length / Math.max(1, slowS),
    },
  };
}
