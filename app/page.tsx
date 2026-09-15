import { Dashboard } from './dashboard';

// Read the deployment identity at request time so it reflects the running
// BACKEND_ID rather than a build-time snapshot.
export const dynamic = 'force-dynamic';

const CHART = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
  'var(--chart-4)', 'var(--chart-5)',
];

function deploymentId(): string {
  return (
    process.env.BACKEND_ID ||
    (process.env.VERCEL_URL ? process.env.VERCEL_URL.split('.')[0] : '') ||
    'local'
  );
}

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h + ch.charCodeAt(0)) % CHART.length;
  return CHART[h];
}

export default function Page() {
  const id = deploymentId();
  const color = colorFor(id);

  return (
    <div className="mx-auto max-w-5xl px-5 pb-16 pt-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">ALB Load-Balancer Tester</h1>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
            Fire traffic through a Datum HTTPProxy and watch which backend serves each request. Tests weighted backends and load-balancing algorithms.
          </p>
        </div>
        <div
          className="bg-card flex shrink-0 items-center gap-2 rounded-full border py-1.5 pl-2.5 pr-3.5 text-xs"
          title="The BACKEND_ID this deployment was given. It is the origin the dashboard runs on, not necessarily the one your proxy routes to."
        >
          <span className="relative flex size-2.5 items-center justify-center">
            <span className="absolute size-2.5 rounded-full opacity-30" style={{ background: color }} />
            <span className="size-1.5 rounded-full" style={{ background: color }} />
          </span>
          <span className="text-muted-foreground">serving this page</span>
          <span className="font-mono font-medium">{id}</span>
        </div>
      </header>

      <Dashboard />
    </div>
  );
}
