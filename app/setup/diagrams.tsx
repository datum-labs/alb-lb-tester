// Inline SVG diagrams for the setup page. Plain shapes coloured with the
// theme's CSS variables, so they follow light and dark mode, and drawn in a
// narrow viewBox so each one stays legible at phone width.

type Tone = 'test' | 'page' | 'blocked';

const TONE: Record<Tone, string> = {
  test: 'var(--chart-2)',
  page: 'var(--muted-foreground)',
  blocked: 'var(--destructive)',
};

const FG = { fill: 'var(--foreground)' };
const MUTED = { fill: 'var(--muted-foreground)' };

function Markers({ id }: { id: string }) {
  return (
    <defs>
      {(Object.keys(TONE) as Tone[]).map((t) => (
        <marker
          key={t}
          id={`${id}-${t}`}
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="9"
          markerHeight="9"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" style={{ fill: TONE[t] }} />
        </marker>
      ))}
    </defs>
  );
}

function Box({ x, y, w, h = 48, title, sub, dim }: { x: number; y: number; w: number; h?: number; title: string; sub?: string; dim?: boolean }) {
  const cx = x + w / 2;
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={8}
        style={{ fill: 'var(--muted)', stroke: dim ? 'var(--muted-foreground)' : 'var(--foreground)', strokeOpacity: dim ? 0.6 : 0.35, strokeWidth: 1.25 }}
        strokeDasharray={dim ? '4 3' : undefined}
      />
      <text x={cx} y={sub ? y + h / 2 - 3 : y + h / 2 + 4} textAnchor="middle" fontSize={12.5} fontWeight={600} style={dim ? MUTED : FG}>
        {title}
      </text>
      {sub && (
        <text x={cx} y={y + h / 2 + 13} textAnchor="middle" fontSize={10.5} style={MUTED}>
          {sub}
        </text>
      )}
    </g>
  );
}

function Zone({ x, y, w, h, label }: { x: number; y: number; w: number; h: number; label: string }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={12} style={{ fill: 'none', stroke: 'var(--muted-foreground)', strokeOpacity: 0.5 }} strokeDasharray="2 4" />
      <text x={x + 10} y={y + 16} fontSize={10.5} fontWeight={600} letterSpacing={0.6} style={MUTED}>
        {label.toUpperCase()}
      </text>
    </g>
  );
}

function Arrow({ id, from, to, tone }: { id: string; from: [number, number]; to: [number, number]; tone: Tone }) {
  const [x1, y1] = from;
  const [x2, y2] = to;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        style={{ stroke: TONE[tone], strokeWidth: tone === 'test' ? 2 : 1.5 }}
        strokeDasharray={tone === 'test' ? undefined : '5 4'}
        markerEnd={`url(#${id}-${tone})`}
      />
      {tone === 'blocked' && (
        <path d={`M${mx - 6},${my - 6} L${mx + 6},${my + 6} M${mx + 6},${my - 6} L${mx - 6},${my + 6}`} style={{ stroke: TONE.blocked, strokeWidth: 2.25 }} />
      )}
    </g>
  );
}

function Note({ x, y, children, anchor = 'start', tone }: { x: number; y: number; children: string; anchor?: 'start' | 'middle' | 'end'; tone?: Tone }) {
  return (
    <text x={x} y={y} textAnchor={anchor} fontSize={10.5} style={{ fill: tone ? TONE[tone] : 'var(--muted-foreground)' }} fontWeight={tone ? 600 : 400}>
      {children}
    </text>
  );
}

function Frame({ id, title, desc, height, children }: { id: string; title: string; desc: string; height: number; children: React.ReactNode }) {
  return (
    <figure className="bg-card rounded-lg border p-3">
      <figcaption className="mb-2 text-sm font-semibold">{title}</figcaption>
      <svg viewBox={`0 0 300 ${height}`} className="mx-auto h-auto w-full max-w-[360px]" role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>{desc}</desc>
        <Markers id={id} />
        {children}
      </svg>
    </figure>
  );
}

/** Legend for the arrow styles, shown under each diagram. */
export function Legend({ blocked }: { blocked?: boolean }) {
  const item = (tone: Tone, text: string) => (
    <span className="inline-flex items-center gap-1.5">
      <svg width="28" height="8" aria-hidden="true">
        <line x1="1" y1="4" x2="27" y2="4" style={{ stroke: TONE[tone], strokeWidth: 2 }} strokeDasharray={tone === 'test' ? undefined : '5 4'} />
      </svg>
      {text}
    </span>
  );
  return (
    <div className="text-muted-foreground mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs">
      {item('test', 'test traffic')}
      {item('page', 'the page, or the dashboard asking its server')}
      {blocked && item('blocked', "can't currently connect")}
    </div>
  );
}

/* ------------------------------------------------ Diagram 1: traffic paths */

export function TrafficPaths() {
  const x = 70;
  const w = 160;
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Frame id="flow-server" title="Server mode" height={352} desc="Your browser asks the dashboard's server to run the test. The dashboard's server sends the test requests to the proxy, which forwards them to the origins.">
        <Box x={x} y={10} w={w} title="Your browser" sub="the dashboard page" />
        <Arrow id="flow-server" from={[150, 58]} to={[150, 104]} tone="page" />
        <Note x={158} y={85}>starts the run</Note>
        <Box x={x} y={104} w={w} title="Dashboard server" sub="/api/inspect, /api/probe" />
        <Arrow id="flow-server" from={[150, 152]} to={[150, 198]} tone="test" />
        <Note x={158} y={179} tone="test">test requests</Note>
        <Box x={x} y={198} w={w} title="Proxy under test" sub="Datum HTTPProxy" />
        <Arrow id="flow-server" from={[150, 246]} to={[150, 292]} tone="test" />
        <Note x={158} y={273} tone="test">forwarded</Note>
        <Box x={x} y={292} w={w} title="Origins" sub="this app's /api/whoami" />
      </Frame>
      <Frame id="flow-browser" title="Browser mode" height={352} desc="The dashboard's server only serves the page. Your browser sends the test requests to the proxy, which forwards them to the origins.">
        <Box x={x} y={10} w={w} title="Dashboard server" sub="serves the page only" dim />
        <Arrow id="flow-browser" from={[150, 58]} to={[150, 104]} tone="page" />
        <Note x={158} y={85}>the page</Note>
        <Box x={x} y={104} w={w} title="Your browser" sub="the dashboard page" />
        <Arrow id="flow-browser" from={[150, 152]} to={[150, 198]} tone="test" />
        <Note x={158} y={179} tone="test">test requests</Note>
        <Box x={x} y={198} w={w} title="Proxy under test" sub="Datum HTTPProxy" />
        <Arrow id="flow-browser" from={[150, 246]} to={[150, 292]} tone="test" />
        <Note x={158} y={273} tone="test">forwarded</Note>
        <Box x={x} y={292} w={w} title="Origins" sub="this app's /api/whoami" />
      </Frame>
    </div>
  );
}

/* --------------------------------------------- Diagram 2: where things run */

export function Deployments() {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <Frame
        id="run-local"
        title="Local or another cloud"
        height={400}
        desc="Your browser and the dashboard server run on your machine or a VM outside Datum. The dashboard server sends test requests to the proxy; the Load balancing tab sends them from your browser. The proxy forwards to origins on Datum Compute."
      >
        <Zone x={6} y={6} w={288} h={150} label="Your machine or VM" />
        <Box x={20} y={36} w={116} title="Your browser" />
        <Box x={164} y={36} w={116} title="Dashboard" sub="npm / docker" />
        <Arrow id="run-local" from={[164, 60]} to={[138, 60]} tone="page" />
        <Note x={92} y={136} anchor="end" tone="test">Load</Note>
        <Note x={92} y={150} anchor="end" tone="test">balancing</Note>
        <Note x={206} y={136} tone="test">other tabs</Note>
        <Note x={206} y={150} tone="test">(Server mode)</Note>
        <Zone x={6} y={176} w={288} h={218} label="Datum" />
        <Arrow id="run-local" from={[78, 84]} to={[132, 220]} tone="test" />
        <Arrow id="run-local" from={[222, 84]} to={[168, 220]} tone="test" />
        <Box x={80} y={220} w={140} title="Proxy under test" sub="your HTTPProxy" />
        <Arrow id="run-local" from={[150, 268]} to={[150, 318]} tone="test" />
        <Box x={60} y={318} w={180} h={56} title="Origins" sub="Compute workload, 3 instances" />
      </Frame>

      <Frame
        id="run-compute"
        title="Hosted on Datum Compute"
        height={400}
        desc="Your browser loads the dashboard from a Compute workload behind a login, and sends the proxy tests itself, because the dashboard can't currently reach Datum proxies. The same workload is the origin. The dashboard reaches instances directly by internal name for Sticky failure."
      >
        <Box x={100} y={10} w={120} title="Your browser" />
        <Zone x={6} y={82} w={288} h={312} label="Datum" />
        <Arrow id="run-compute" from={[124, 58]} to={[84, 112]} tone="test" />
        <Box x={20} y={112} w={128} title="Proxy under test" sub="your HTTPProxy" />
        <Arrow id="run-compute" from={[210, 58]} to={[248, 256]} tone="page" />
        <Note x={236} y={140} anchor="start">page,</Note>
        <Note x={236} y={154} anchor="start">login</Note>
        <Arrow id="run-compute" from={[198, 256]} to={[150, 162]} tone="blocked" />
        <Note x={90} y={196} tone="test">browser</Note>
        <Note x={90} y={210} tone="test">mode</Note>
        <Arrow id="run-compute" from={[84, 160]} to={[84, 256]} tone="test" />
        <rect x={14} y={226} width={272} height={152} rx={10} style={{ fill: 'none', stroke: 'var(--foreground)', strokeOpacity: 0.25 }} />
        <Note x={24} y={242}>ONE WORKLOAD</Note>
        <Box x={24} y={256} w={112} h={56} title="/api/whoami" sub="origin" />
        <Box x={176} y={256} w={100} h={56} title="Dashboard" sub="behind a login" />
        <Arrow id="run-compute" from={[176, 296]} to={[138, 296]} tone="page" />
        <Note x={150} y={336} anchor="middle">Sticky failure: dashboard → each</Note>
        <Note x={150} y={350} anchor="middle">instance by internal name,</Note>
        <Note x={150} y={364} anchor="middle">not through the proxy</Note>
      </Frame>

      <Frame
        id="run-ci"
        title="CI origin only"
        height={400}
        desc="Automated load-balancing tests send requests to the proxy, which forwards them to origins running with ORIGIN_ONLY=1. There is no dashboard."
      >
        <Box x={70} y={10} w={160} title="Automated LB tests" sub="CI, curl, scripts" />
        <Zone x={6} y={82} w={288} h={312} label="Datum" />
        <Arrow id="run-ci" from={[150, 58]} to={[150, 120]} tone="test" />
        <Box x={80} y={120} w={140} title="Proxy under test" sub="HTTPProxy" />
        <Arrow id="run-ci" from={[150, 168]} to={[150, 230]} tone="test" />
        <Box x={50} y={230} w={200} h={56} title="Origins" sub="ORIGIN_ONLY=1" />
        <Note x={150} y={318} anchor="middle">/api/whoami only;</Note>
        <Note x={150} y={332} anchor="middle">no dashboard, no server-side tools</Note>
      </Frame>
    </div>
  );
}
