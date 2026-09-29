/**
 * Analysis for the health-check (passive outlier detection) test.
 *
 * A run has three phases at a steady request rate:
 *   baseline  — nothing fails; confirms the target backend gets traffic
 *   failing   — requests carry ?fail=<target>, so only the target answers 5xx
 *   recovery  — failures stop; watches for the target to be re-admitted
 *
 * With outlier detection on, the proxy should stop sending the target traffic
 * after a run of 5xx (ejection), try it again when the ejection period ends
 * (and eject it again, for longer, while it's still failing), and serve it
 * normally once it's healthy and re-admitted.
 */

export type Phase = 'baseline' | 'failing' | 'recovery';

export type HealthSample = {
  n: number;
  /** ms since the run started, taken when the request was sent. */
  t: number;
  phase: Phase;
  /** Which of our origins answered; null when the proxy answered itself. */
  backendId: string | null;
  status: number;
};

export type Outcome = 'ok' | 'target-5xx' | 'backend-5xx' | 'proxy-5xx' | 'error' | 'other';

export function outcomeOf(sample: HealthSample, target: string): Outcome {
  if (sample.status === 0) return 'error';
  if (sample.status >= 200 && sample.status < 400) return 'ok';
  if (sample.status >= 500) {
    if (!sample.backendId) return 'proxy-5xx';
    return sample.backendId === target ? 'target-5xx' : 'backend-5xx';
  }
  return 'other';
}

export type Bucket = {
  second: number;
  phase: Phase;
  /** 2xx/3xx responses per backend. */
  ok: Map<string, number>;
  target5xx: number;
  backend5xx: number;
  proxy5xx: number;
  errors: number;
  /** Requests that reached the target at all, healthy or not. */
  toTarget: number;
  total: number;
};

export function phaseAt(second: number, baselineS: number, failingS: number): Phase {
  if (second < baselineS) return 'baseline';
  if (second < baselineS + failingS) return 'failing';
  return 'recovery';
}

export function bucketize(
  samples: HealthSample[],
  target: string,
  totalSeconds: number,
  baselineS: number,
  failingS: number,
): Bucket[] {
  const buckets: Bucket[] = Array.from({ length: totalSeconds }, (_, second) => ({
    second,
    phase: phaseAt(second, baselineS, failingS),
    ok: new Map(),
    target5xx: 0,
    backend5xx: 0,
    proxy5xx: 0,
    errors: 0,
    toTarget: 0,
    total: 0,
  }));
  for (const sample of samples) {
    const bucket = buckets[Math.floor(sample.t / 1000)];
    if (!bucket) continue;
    bucket.total += 1;
    if (sample.backendId === target) bucket.toTarget += 1;
    switch (outcomeOf(sample, target)) {
      case 'ok':
        bucket.ok.set(sample.backendId ?? 'unknown', (bucket.ok.get(sample.backendId ?? 'unknown') ?? 0) + 1);
        break;
      case 'target-5xx':
        bucket.target5xx += 1;
        break;
      case 'backend-5xx':
        bucket.backend5xx += 1;
        break;
      case 'proxy-5xx':
        bucket.proxy5xx += 1;
        break;
      case 'error':
        bucket.errors += 1;
        break;
    }
  }
  return buckets;
}

/**
 * How many requests the target would normally have received in a quiet
 * stretch before that stretch counts as an ejection. A fixed number of quiet
 * seconds isn't enough: at a low rate, or with a small share, the target can
 * go several seconds without traffic by chance. Five expected requests with
 * none arriving is well under a 1% chance at any share.
 */
export const EXPECTED_REQUESTS_TO_EJECT = 5;
/** Below this share of the requested rate, the run is too thin to judge. */
export const MIN_RATE_RATIO = 0.7;

export type HealthVerdict = {
  baselineToTarget: number;
  baselineBackends: string[];
  /** Share of baseline requests the target served; the yardstick for "quiet". */
  baselineShare: number;
  /** Seconds into the failing phase when the target stopped receiving traffic. */
  ejectedAfterS: number | null;
  /** Target 5xx responses before it was ejected. */
  failuresBeforeEject: number | null;
  /** Target 5xx responses across the whole failing phase. */
  targetFailures: number;
  /** Times the target got traffic again, still failing, after being ejected. */
  retriesWhileFailing: number;
  /** Share of failing-phase requests that reached the target. */
  targetShareFailing: number;
  /** Seconds after failures stopped until the target served a 2xx again. */
  readmittedAfterS: number | null;
  /** Requests per second actually sent in each phase. */
  achievedRate: Record<Phase, number>;
  /** Some phase ran well below the requested rate, so the verdict is unreliable. */
  rateTooLow: boolean;
  proxy5xx: number;
  errors: number;
};

export function analyse(
  samples: HealthSample[],
  buckets: Bucket[],
  target: string,
  baselineS: number,
  failingS: number,
  requestedRate: number,
): HealthVerdict {
  const failStart = baselineS;
  const failEnd = baselineS + failingS;
  const recoveryS = Math.max(1, buckets.length - failEnd);

  const baseline = samples.filter((s) => s.phase === 'baseline');
  const baselineBackends = [...new Set(baseline.map((s) => s.backendId).filter((id): id is string => !!id))];
  const baselineToTarget = baseline.filter((s) => s.backendId === target).length;
  const baselineShare = baseline.length ? baselineToTarget / baseline.length : 0;
  const failing = samples.filter((s) => s.phase === 'failing');
  const recovery = samples.filter((s) => s.phase === 'recovery');

  // A quiet stretch is a run of seconds with no traffic to the target; it
  // counts as an ejection once the target would have expected enough requests
  // in it (by its baseline share) that getting none isn't chance.
  const quietWindows: { start: number; end: number }[] = [];
  if (baselineShare > 0) {
    let runStart: number | null = null;
    let runTotal = 0;
    const close = (end: number) => {
      if (runStart !== null && runTotal * baselineShare >= EXPECTED_REQUESTS_TO_EJECT) {
        quietWindows.push({ start: runStart, end });
      }
      runStart = null;
      runTotal = 0;
    };
    for (let s = failStart; s < failEnd && s < buckets.length; s++) {
      const b = buckets[s];
      if (b.toTarget === 0) {
        if (runStart === null) runStart = s;
        runTotal += b.total;
      } else {
        close(s);
      }
    }
    close(Math.min(failEnd, buckets.length));
  }

  const firstEjection = quietWindows[0];
  // Each qualifying quiet stretch that ends with the target getting traffic
  // again, still inside the failure window, is the proxy trying it once an
  // ejection period ran out.
  const retriesWhileFailing = quietWindows.filter((w) => w.end < failEnd).length;

  const achievedRate: Record<Phase, number> = {
    baseline: baseline.length / Math.max(1, baselineS),
    failing: failing.length / Math.max(1, failingS),
    recovery: recovery.length / recoveryS,
  };
  const rateTooLow = (['baseline', 'failing', 'recovery'] as Phase[]).some(
    (phase) => achievedRate[phase] < requestedRate * MIN_RATE_RATIO,
  );

  const readmit = firstEjection
    ? samples
        .filter((s) => s.phase === 'recovery' && s.backendId === target && outcomeOf(s, target) === 'ok')
        .sort((a, b) => a.t - b.t)[0]
    : undefined;

  return {
    baselineToTarget,
    baselineBackends,
    baselineShare,
    ejectedAfterS: firstEjection ? firstEjection.start - failStart : null,
    failuresBeforeEject: firstEjection
      ? failing.filter((s) => s.t < firstEjection.start * 1000 && outcomeOf(s, target) === 'target-5xx').length
      : null,
    targetFailures: failing.filter((s) => outcomeOf(s, target) === 'target-5xx').length,
    retriesWhileFailing,
    targetShareFailing: failing.length ? failing.filter((s) => s.backendId === target).length / failing.length : 0,
    readmittedAfterS: readmit ? Math.max(0, readmit.t / 1000 - failEnd) : null,
    achievedRate,
    rateTooLow,
    proxy5xx: samples.filter((s) => outcomeOf(s, target) === 'proxy-5xx').length,
    errors: samples.filter((s) => outcomeOf(s, target) === 'error').length,
  };
}
