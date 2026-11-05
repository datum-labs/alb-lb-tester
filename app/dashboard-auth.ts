// DASHBOARD_AUTH=user:password puts the dashboard, the inspector, the probe
// and the sticky failure API behind HTTP basic auth (see proxy.ts); without
// it, the sticky failure API doesn't exist. /api/whoami stays open: it's the
// origin that proxies, health checks and automated tests call.
//
// Behind a login, the inspector and probe may also reach this network's
// internal names (*.datum.internal), so a test can hit one instance directly.
// Without one they stay public-only, since anyone could use them.

const raw = process.env.DASHBOARD_AUTH ?? '';
const i = raw.indexOf(':');

export const dashboardAuth = i > 0 ? { user: raw.slice(0, i), password: raw.slice(i + 1) } : null;

/** Internal names are reachable only when every caller has had to log in. */
export const internalTargetsAllowed = dashboardAuth !== null;

export const INTERNAL_SUFFIX = '.datum.internal';
