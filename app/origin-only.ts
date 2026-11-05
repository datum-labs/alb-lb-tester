// ORIGIN_ONLY=1 runs the app as an origin and nothing else: /api/whoami
// answers, and the dashboard, the inspector and the probe return 404. For
// deployments that exist only to sit behind a proxy under test, such as the
// standing Chainsaw origins, so they don't expose public server-side fetch
// tools that nobody there uses.
export const originOnly = process.env.ORIGIN_ONLY === '1';
