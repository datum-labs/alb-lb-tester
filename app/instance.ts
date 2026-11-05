import { dashboardAuth } from './dashboard-auth';
import type { FailureSpec } from './failure';
import { originOnly } from './origin-only';

// This instance's identity and its sticky failure, shared by /api/whoami and
// /api/sticky-failure. Kept on globalThis so every route sees the same values
// even if the bundler gives each route its own copy of this module.

/**
 * A failure applied to every /api/whoami request until it's reset or expires.
 * In memory only: a restart clears it.
 */
export type Sticky = { spec: FailureSpec; setAt: number; expiresAt: number };

type State = { instanceId: string; sticky: Sticky | null };

const KEY = Symbol.for('alb-lb-tester.instance');
const g = globalThis as typeof globalThis & { [KEY]?: State };

// Per-instance identity. A warm serverless instance keeps it across requests;
// a cold start resets it. Useful for spotting round-robin / least-request
// behaviour landing on the same instance. On Datum Compute each instance is
// one of the backend's endpoints, so this is also what the health check test
// fails when it targets a single endpoint. INSTANCE_ID overrides it.
const state: State = (g[KEY] ??= {
  instanceId: process.env.INSTANCE_ID || Math.random().toString(36).slice(2, 8),
  sticky: null,
});

export const instanceId = state.instanceId;

export function backendId(): string {
  if (process.env.BACKEND_ID) return process.env.BACKEND_ID;
  // Fall back to the Vercel deployment host so multiple deploys are still
  // distinguishable without setting BACKEND_ID.
  if (process.env.VERCEL_URL) return process.env.VERCEL_URL.split('.')[0];
  return 'local';
}

/**
 * Sticky failure needs DASHBOARD_AUTH, and is off under ORIGIN_ONLY. The
 * standing test origins run without a login, so nothing there can be left
 * broken by a killed run: every failure they show was asked for by the
 * request that got it.
 */
export const stickyAllowed = dashboardAuth !== null && !originOnly;

/** How long a sticky failure lasts unless reset first, and the most it may be set for. */
export const DEFAULT_STICKY_TTL_S = 30 * 60;
export const MAX_STICKY_TTL_S = 24 * 60 * 60;

/** The active sticky failure, or null. One past its expiry is cleared here. */
export function currentSticky(): Sticky | null {
  if (!stickyAllowed) return null;
  if (state.sticky && Date.now() >= state.sticky.expiresAt) state.sticky = null;
  return state.sticky;
}

export function setSticky(spec: FailureSpec, ttlS: number): Sticky {
  const setAt = Date.now();
  state.sticky = { spec, setAt, expiresAt: setAt + ttlS * 1000 };
  return state.sticky;
}

export function clearSticky(): void {
  state.sticky = null;
}
