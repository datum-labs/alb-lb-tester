// How an origin misbehaves, shared by the per-request flags (`?fail=` on
// /api/whoami) and the sticky failure an instance can be put in
// (/api/sticky-failure). Both take the same parameters.

// Longest a delay may be asked for, and how long a hang holds a request
// before giving up on it, so a forgotten client can't pin an instance forever.
export const MAX_DELAY_MS = 60_000;
export const MAX_HANG_MS = 10 * 60_000;

export const FAIL_MODES = ['error', 'delay', 'jitter', 'hang'] as const;
export type FailMode = (typeof FAIL_MODES)[number];

/** What was asked for, under the parameter names it was asked with. */
export type FailureSpec = {
  failMode: FailMode;
  failPercent: number;
  failStatus?: number;
  delayMs?: number;
  jitterMin?: number;
  jitterMax?: number;
};

/** What one request gets. */
export type Failure =
  | { mode: 'error'; status: number }
  | { mode: 'delay' | 'jitter'; delayMs: number }
  | { mode: 'hang' };

function intParam(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const n = Number(params.get(name) ?? fallback);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}

/**
 * Reads the failure parameters, clamping numbers into range:
 *   failMode     error (default) | delay | jitter | hang
 *   failStatus   5xx answered in error mode (default 503)
 *   delayMs      wait before answering 200 in delay mode (default 1000)
 *   jitterMin/Max  random wait range in jitter mode (default 100..2000)
 *   failPercent  share of requests that misbehave (0-100, default 100)
 * An unknown failMode reads as error.
 */
export function failureSpec(params: URLSearchParams): FailureSpec {
  const failPercent = intParam(params, 'failPercent', 100, 0, 100);
  switch (params.get('failMode')) {
    case 'delay':
      return { failMode: 'delay', failPercent, delayMs: intParam(params, 'delayMs', 1000, 0, MAX_DELAY_MS) };
    case 'jitter': {
      const jitterMin = intParam(params, 'jitterMin', 100, 0, MAX_DELAY_MS);
      const jitterMax = Math.max(jitterMin, intParam(params, 'jitterMax', 2000, 0, MAX_DELAY_MS));
      return { failMode: 'jitter', failPercent, jitterMin, jitterMax };
    }
    case 'hang':
      return { failMode: 'hang', failPercent };
    default: {
      const requested = Number(params.get('failStatus') ?? 503);
      const failStatus = Number.isInteger(requested) && requested >= 500 && requested <= 599 ? requested : 503;
      return { failMode: 'error', failPercent, failStatus };
    }
  }
}

/** The failure for one request, or null when `failPercent` lets it through. */
export function rollFailure(spec: FailureSpec): Failure | null {
  if (Math.random() * 100 >= spec.failPercent) return null;
  switch (spec.failMode) {
    case 'delay':
      return { mode: 'delay', delayMs: spec.delayMs ?? 1000 };
    case 'jitter': {
      const min = spec.jitterMin ?? 100;
      const max = spec.jitterMax ?? 2000;
      return { mode: 'jitter', delayMs: Math.floor(min + Math.random() * (max - min)) };
    }
    case 'hang':
      return { mode: 'hang' };
    default:
      return { mode: 'error', status: spec.failStatus ?? 503 };
  }
}
