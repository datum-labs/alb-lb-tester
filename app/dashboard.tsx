'use client';

import { Activity, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion, useSpring, useTransform, type Variants } from 'motion/react';
import { Card, CardContent, CardHeader, CardTitle } from '@datum-cloud/datum-ui/card';
import { Button } from '@datum-cloud/datum-ui/button';
import { Input } from '@datum-cloud/datum-ui/input';
import { Label } from '@datum-cloud/datum-ui/label';
import { Badge } from '@datum-cloud/datum-ui/badge';
import { Switch } from '@datum-cloud/datum-ui/switch';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@datum-cloud/datum-ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@datum-cloud/datum-ui/select';
import {
  analyse,
  bucketize,
  outcomeOf,
  type HealthSample,
  type Phase,
} from './health-analysis';

type Result = {
  n: number;
  backendId: string;
  status: number;
  ok: boolean;
  ms: number;
  lbKey: string | null;
  ts: number;
};

type KeyMode = 'none' | 'constant' | 'random' | 'sequential';
type WafRow = { kind: 'attack' | 'benign'; label: string; status: number; blocked: boolean };

const EASE = [0.23, 1, 0.32, 1] as const;
const CHART = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)'];

const KEY_MODES: { value: KeyMode; label: string }[] = [
  { value: 'none', label: 'None — plain requests' },
  { value: 'constant', label: 'Constant — same key (stickiness)' },
  { value: 'random', label: 'Random — new key per request (spread)' },
  { value: 'sequential', label: 'Sequential — key-0, key-1, …' },
];

const ATTACKS: { label: string; key: string; value: string }[] = [
  { label: 'XSS · script tag', key: 'q', value: '<script>alert(1)</script>' },
  { label: 'XSS · img onerror', key: 'x', value: '<img src=x onerror=alert(1)>' },
  { label: 'SQLi · OR 1=1', key: 'id', value: "1' OR '1'='1" },
  { label: 'SQLi · UNION', key: 'id', value: '1 UNION SELECT password FROM users' },
  { label: 'Command injection', key: 'cmd', value: ';cat /etc/passwd' },
  { label: 'Path traversal', key: 'file', value: '../../../../etc/passwd' },
];
const BENIGN: { label: string; path: string }[] = [
  { label: 'Home page', path: '/' },
  { label: 'whoami', path: '/api/whoami' },
];

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}
function parseWeights(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const part of s.split(/[,\n]/)) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (k && v && !Number.isNaN(+v)) m.set(k, +v);
  }
  return m;
}
function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

type TabId = 'load' | 'inspect' | 'waf' | 'health';
const TAB_STORAGE_KEY = 'alb-tester:tab';

export function Dashboard() {
  const [proxyUrl, setProxyUrl] = useState('');
  const [path, setPath] = useState('/api/whoami');
  const [tab, setTab] = useState<TabId>('load');
  const reduce = useReducedMotion();

  // Restore the last-used tab, then keep it in sync across reloads.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_STORAGE_KEY);
      if (saved === 'load' || saved === 'inspect' || saved === 'waf' || saved === 'health') setTab(saved);
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {}
  }, [tab]);

  const base = useMemo(() => proxyUrl.trim().replace(/\/+$/, ''), [proxyUrl]);
  const target = (p = path) => `${base}${p.startsWith('/') ? '' : '/'}${p}`;

  const item = reduce
    ? { hidden: { opacity: 0 }, show: { opacity: 1 } }
    : { hidden: { opacity: 0, y: 8 }, show: { opacity: 1, y: 0, transition: { duration: 0.28, ease: EASE } } };
  const container = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } };

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-3 sm:grid-cols-[1fr_240px]">
          <div className="space-y-1.5">
            <Label htmlFor="proxy">Proxy base URL</Label>
            <Input id="proxy" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="https://your-alb.datumproxy.net" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="path">Request path</Label>
            <Input id="path" value={path} onChange={(e) => setPath(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabId)}>
        <TabsList variant="line">
          <TabsTrigger value="load">Load balancing</TabsTrigger>
          <TabsTrigger value="inspect">Headers &amp; redirect</TabsTrigger>
          <TabsTrigger value="waf">WAF probes</TabsTrigger>
          <TabsTrigger value="health">Health checks</TabsTrigger>
        </TabsList>

        {/* forceMount keeps all panels in the DOM; <Activity> preserves each
            tab's state and pauses the hidden panels' effects. */}
        <TabsContent value="load" forceMount className="mt-4 data-[state=inactive]:hidden">
          <Activity mode={tab === 'load' ? 'visible' : 'hidden'}>
            <LoadTab base={base} target={target} item={item} container={container} reduce={!!reduce} />
          </Activity>
        </TabsContent>

        <TabsContent value="inspect" forceMount className="mt-4 data-[state=inactive]:hidden">
          <Activity mode={tab === 'inspect' ? 'visible' : 'hidden'}>
            <InspectTab base={base} target={target} item={item} container={container} />
          </Activity>
        </TabsContent>

        <TabsContent value="waf" forceMount className="mt-4 data-[state=inactive]:hidden">
          <Activity mode={tab === 'waf' ? 'visible' : 'hidden'}>
            <WafTab base={base} path={path} item={item} container={container} />
          </Activity>
        </TabsContent>

        <TabsContent value="health" forceMount className="mt-4 data-[state=inactive]:hidden">
          <Activity mode={tab === 'health' ? 'visible' : 'hidden'}>
            <HealthTab base={base} target={target} item={item} container={container} />
          </Activity>
        </TabsContent>
      </Tabs>
    </div>
  );
}

/* ---------------------------------------------------------------- Load tab */

function LoadTab({
  base, target, item, container, reduce,
}: { base: string; target: (p?: string) => string; item: Variants; container: Variants; reduce: boolean }) {
  const [count, setCount] = useState(100);
  const [concurrency, setConcurrency] = useState(10);
  const [live, setLive] = useState(false);
  const [keyMode, setKeyMode] = useState<KeyMode>('none');
  const [keyHeader, setKeyHeader] = useState('x-lb-key');
  const [keyValue, setKeyValue] = useState('session-1');
  const [weightsInput, setWeightsInput] = useState('');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const cancel = useRef(false);
  const store = useRef<Result[]>([]);

  const rpsMV = useSpring(0, { stiffness: 120, damping: 24, restDelta: 0.4 });
  const rpsText = useTransform(rpsMV, (v) => Math.max(0, Math.round(v)).toString());

  function rpsNow(now: number) {
    const w = store.current.filter((r) => now - r.ts < 4000).length;
    return w / 4;
  }

  async function startRun() {
    if (!base) { setNote('Enter the proxy base URL above first.'); return; }
    setRunning(true); setNote(null); setDone(0); store.current = []; setResults([]);
    cancel.current = false;
    const total = live ? Infinity : Math.max(1, Math.min(2000, Math.floor(count)));
    const pool = Math.max(1, Math.min(50, Math.floor(concurrency)));
    const url = target();
    let next = 0;

    const flush = setInterval(() => {
      setResults(store.current.slice());
      rpsMV.set(rpsNow(Date.now()));
    }, 300);

    async function worker() {
      while (!cancel.current) {
        const n = next++;
        if (n >= total) return;
        const headers: Record<string, string> = {};
        let lbKey: string | null = null;
        if (keyMode === 'constant') lbKey = keyValue;
        else if (keyMode === 'random') lbKey = Math.random().toString(36).slice(2, 10);
        else if (keyMode === 'sequential') lbKey = `${keyValue}-${n}`;
        if (lbKey !== null) headers[keyHeader] = lbKey;

        const t0 = performance.now();
        let r: Result;
        try {
          const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${n}`, { headers, cache: 'no-store' });
          const ms = performance.now() - t0;
          let backendId = res.headers.get('x-backend-id') ?? 'unknown';
          try { const j = await res.json(); if (j && typeof j.backendId === 'string') backendId = j.backendId; } catch { /* non-JSON */ }
          r = { n, backendId: res.ok ? backendId : `HTTP ${res.status}`, status: res.status, ok: res.ok, ms, lbKey, ts: Date.now() };
        } catch {
          r = { n, backendId: 'network error', status: 0, ok: false, ms: performance.now() - t0, lbKey, ts: Date.now() };
        }
        store.current.push(r);
        if (store.current.length > 4000) store.current.splice(0, store.current.length - 3000);
        setDone((d) => d + 1);
      }
    }

    await Promise.all(Array.from({ length: pool }, worker));
    clearInterval(flush);
    if (!live) store.current.sort((a, b) => a.n - b.n);
    setResults(store.current.slice());
    rpsMV.set(0);
    setRunning(false);
  }

  const s = useMemo(() => {
    const ok = results.filter((r) => r.ok);
    const counts = new Map<string, number>();
    const lat = new Map<string, number[]>();
    for (const r of results) {
      counts.set(r.backendId, (counts.get(r.backendId) ?? 0) + 1);
      if (r.ok) { const a = lat.get(r.backendId) ?? []; a.push(r.ms); lat.set(r.backendId, a); }
    }
    const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const backends = order.filter((id) => results.some((r) => r.backendId === id && r.ok));
    const allLat = ok.map((r) => r.ms).sort((a, b) => a - b);
    const perBackend = backends.map((id) => {
      const l = (lat.get(id) ?? []).slice().sort((a, b) => a - b);
      return { id, count: counts.get(id) ?? 0, p50: percentile(l, 50), p95: percentile(l, 95) };
    });
    return {
      counts, order, backends, perBackend,
      total: results.length, okCount: ok.length, errCount: results.length - ok.length,
      p50: percentile(allLat, 50), p95: percentile(allLat, 95), max: allLat.length ? allLat[allLat.length - 1] : 0,
    };
  }, [results]);

  const colorMap = useMemo(() => {
    const m = new Map<string, string>();
    s.backends.forEach((id, i) => m.set(id, CHART[i % CHART.length]));
    return m;
  }, [s.backends]);
  const colorFor = (id: string) => colorMap.get(id) ?? 'var(--destructive)';

  const weights = useMemo(() => parseWeights(weightsInput), [weightsInput]);
  const weightSum = useMemo(() => [...weights.values()].reduce((a, b) => a + b, 0), [weights]);

  const sticky = useMemo(() => {
    if (keyMode !== 'constant' || s.okCount === 0) return null;
    const set = new Set(results.filter((r) => r.ok).map((r) => r.backendId));
    if (set.size === 1) return { good: true, text: `Sticky: all ${s.okCount} requests with the same ${keyHeader} landed on "${[...set][0]}".` };
    return { good: false, text: `Not sticky: a constant ${keyHeader} spread across ${set.size} backends.` };
  }, [keyMode, results, s.okCount, keyHeader]);

  const maxCount = Math.max(1, ...[...s.counts.values()]);
  const timeline = live ? results.slice(-600) : results.slice(0, 600);

  return (
    <div className="grid items-start gap-4 md:grid-cols-[340px_1fr]">
      <Card>
        <CardHeader><CardTitle className="text-sm">Load configuration</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="count">Requests</Label>
              <Input id="count" type="number" min={1} max={2000} value={count} onChange={(e) => setCount(+e.target.value)} disabled={live} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="conc">Concurrency</Label>
              <Input id="conc" type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} />
            </div>
          </div>

          <label className="bg-muted flex cursor-pointer items-center justify-between rounded-md px-3 py-2.5">
            <span className="text-sm font-medium">Live mode</span>
            <Switch checked={live} onCheckedChange={setLive} disabled={running} />
          </label>

          <div className="space-y-1.5">
            <Label>Hash key mode</Label>
            <Select value={keyMode} onValueChange={(v) => setKeyMode(v as KeyMode)}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {KEY_MODES.map((m) => <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          {keyMode !== 'none' && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="hn">Header name</Label>
                <Input id="hn" value={keyHeader} onChange={(e) => setKeyHeader(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="hv">Key value</Label>
                <Input id="hv" value={keyValue} onChange={(e) => setKeyValue(e.target.value)} disabled={keyMode === 'random'} />
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="w">Expected weights <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Input id="w" value={weightsInput} onChange={(e) => setWeightsInput(e.target.value)} placeholder="backend-a=80, backend-b=20" />
            <p className="text-muted-foreground text-xs">Compares observed share against the weights you configured.</p>
          </div>

          {!running ? (
            <Button block onClick={startRun}>{live ? 'Start' : 'Send traffic'}</Button>
          ) : (
            <Button block theme="outline" onClick={() => (cancel.current = true)}>
              Stop {live ? '' : `· ${done}/${count}`}
            </Button>
          )}
          {results.length > 0 && (
            <Button block theme="link" onClick={() => download('alb-load-results.csv',
              'n,backendId,status,ms,lbKey\n' + results.map((r) => `${r.n},${r.backendId},${r.status},${r.ms.toFixed(0)},${r.lbKey ?? ''}`).join('\n'))}>
              Export CSV
            </Button>
          )}
          {note && <p className="text-destructive text-xs">{note}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle className="text-sm">Results</CardTitle>
          {running && live && (
            <div className="flex items-center gap-2 text-xs">
              <motion.span className="bg-chart-2 size-2 rounded-full" animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }} style={{ background: 'var(--chart-2)' }} />
              <motion.span className="font-mono text-sm font-semibold tabular-nums">{rpsText}</motion.span>
              <span className="text-muted-foreground">req/s</span>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {results.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">No traffic yet. Send requests to see the distribution.</div>
          ) : (
            <motion.div className="space-y-5" variants={container} initial="hidden" animate="show">
              <motion.div variants={item} className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <Stat n={s.total} label="Requests" />
                <Stat n={s.okCount} label="OK" tone="var(--chart-2)" />
                <Stat n={s.errCount} label="Errors" tone={s.errCount ? 'var(--destructive)' : undefined} />
                <Stat n={s.backends.length} label="Backends" />
              </motion.div>

              <motion.div variants={item} className="grid grid-cols-3 gap-2.5">
                <Stat n={<>{s.p50.toFixed(0)}<Unit>ms</Unit></>} label="p50 latency" />
                <Stat n={<>{s.p95.toFixed(0)}<Unit>ms</Unit></>} label="p95 latency" />
                <Stat n={<>{s.max.toFixed(0)}<Unit>ms</Unit></>} label="max latency" />
              </motion.div>

              {sticky && (
                <motion.div variants={item} className="rounded-md border px-3 py-2.5 text-sm"
                  style={{ borderColor: sticky.good ? 'var(--chart-2)' : 'var(--chart-5)', background: `color-mix(in oklch, ${sticky.good ? 'var(--chart-2)' : 'var(--chart-5)'} 12%, var(--card))` }}>
                  {sticky.text}
                </motion.div>
              )}

              <motion.div variants={item}>
                <SectionLabel>Distribution</SectionLabel>
                <div className="space-y-2">
                  {s.order.map((id) => {
                    const c = s.counts.get(id) ?? 0;
                    const share = (c / s.total) * 100;
                    const isErr = !s.backends.includes(id);
                    const exp = weightSum > 0 && weights.has(id) ? (weights.get(id)! / weightSum) * 100 : null;
                    const delta = exp === null ? null : share - exp;
                    return (
                      <div className="flex items-center gap-3" key={id}>
                        <div className="w-[150px] truncate font-mono text-xs" title={id}>{id}</div>
                        <div className="bg-muted h-6 flex-1 overflow-hidden rounded">
                          <motion.div className="h-full rounded" style={{ background: isErr ? 'var(--destructive)' : colorFor(id), minWidth: 3 }}
                            initial={reduce ? false : { width: 0 }} animate={{ width: `${(c / maxCount) * 100}%` }} transition={{ duration: 0.5, ease: EASE }} />
                        </div>
                        <div className="w-[132px] text-right text-xs tabular-nums">
                          <span className="text-foreground">{c} · {share.toFixed(1)}%</span>
                          {exp !== null && (
                            <span className="text-muted-foreground"> / {exp.toFixed(0)}%
                              <span style={{ color: Math.abs(delta!) <= 5 ? 'var(--chart-2)' : 'var(--chart-5)' }}> ({delta! >= 0 ? '+' : ''}{delta!.toFixed(0)})</span>
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>

              <motion.div variants={item}>
                <SectionLabel>Sequence <span className="text-muted-foreground/70 normal-case">— {live ? 'last' : 'first'} {timeline.length}</span></SectionLabel>
                <div className="flex max-h-24 flex-wrap gap-0.5 overflow-hidden">
                  {timeline.map((r) => (
                    <div key={r.n} className="size-2 rounded-[2px]" title={`#${r.n} · ${r.backendId}`} style={{ background: r.ok ? colorFor(r.backendId) : 'var(--destructive)' }} />
                  ))}
                </div>
              </motion.div>

              {s.perBackend.length > 0 && (
                <motion.div variants={item}>
                  <SectionLabel>Per-backend</SectionLabel>
                  <table className="w-full text-xs tabular-nums">
                    <thead><tr className="text-muted-foreground text-left">
                      <Th>Backend</Th><Th>Requests</Th><Th>Share</Th><Th>p50</Th><Th>p95</Th>
                    </tr></thead>
                    <tbody>
                      {s.perBackend.map((b) => (
                        <tr key={b.id}>
                          <Td className="font-mono"><Dot color={colorFor(b.id)} />{b.id}</Td>
                          <Td>{b.count}</Td>
                          <Td>{((b.count / s.total) * 100).toFixed(1)}%</Td>
                          <Td>{b.p50.toFixed(0)}ms</Td>
                          <Td>{b.p95.toFixed(0)}ms</Td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </motion.div>
              )}
            </motion.div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- Inspect tab */

function InspectTab({ base, target, item, container }: { base: string; target: (p?: string) => string; item: Variants; container: Variants }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    if (!base) { setErr('Enter the proxy base URL above first.'); return; }
    setLoading(true); setErr(null); setData(null);
    try {
      const res = await fetch(`/api/inspect?url=${encodeURIComponent(target())}`, { cache: 'no-store' });
      setData(await res.json());
    } catch (e) { setErr(String(e)); }
    setLoading(false);
  }

  const get = data?.get;
  const seen = get?.requestHeadersSeen as Record<string, string> | null | undefined;
  const resp = get?.responseHeaders as Record<string, string> | undefined;
  const proxyHost = (() => { try { return new URL(base).host; } catch { return ''; } })();
  const hostSeen = seen?.host;
  const hostOverridden = hostSeen && proxyHost && hostSeen !== proxyHost;
  const hsts = resp?.['strict-transport-security'];
  const redirect = data?.redirect;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[340px_1fr]">
      <Card>
        <CardHeader><CardTitle className="text-sm">Inspect</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">Fetches the target from the server to read the Host the origin received, the response headers the proxy returned, and whether http redirects to https.</p>
          <Button block loading={loading} onClick={run}>Inspect target</Button>
          {err && <p className="text-destructive text-xs">{err}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Response</CardTitle></CardHeader>
        <CardContent>
          {!data ? (
            <div className="text-muted-foreground py-12 text-center text-sm">No inspection yet.</div>
          ) : get?.error ? (
            <p className="text-destructive text-sm">{get.error}</p>
          ) : (
            <motion.div className="space-y-5" variants={container} initial="hidden" animate="show">
              <motion.div variants={item} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge type={get.ok ? 'success' : 'danger'}>{get.status}</Badge>
                {get.backendId && <span className="font-mono">served by {get.backendId}</span>}
                <span className="text-muted-foreground">· {get.ms}ms</span>
              </motion.div>

              <motion.div variants={item} className="rounded-md px-3 py-2.5 text-sm"
                style={{ background: `color-mix(in oklch, ${hostOverridden ? 'var(--chart-2)' : 'var(--muted)'} ${hostOverridden ? '14%' : '100%'}, var(--card))` }}>
                <span className="text-muted-foreground">Host the origin received: </span>
                <span className="font-mono font-medium">{hostSeen ?? '—'}</span>
                {hostOverridden ? <span className="text-muted-foreground"> (overridden from {proxyHost})</span> : hostSeen ? <span className="text-muted-foreground"> (unchanged)</span> : null}
              </motion.div>

              <motion.div variants={item} className="rounded-md px-3 py-2.5 text-sm"
                style={{ background: `color-mix(in oklch, ${hsts ? 'var(--chart-2)' : 'var(--chart-5)'} 12%, var(--card))` }}>
                <span className="text-muted-foreground">HSTS: </span>
                {hsts ? <span className="font-mono">{hsts}</span> : <span>not set</span>}
              </motion.div>

              {redirect && (
                <motion.div variants={item} className="rounded-md px-3 py-2.5 text-sm"
                  style={{ background: `color-mix(in oklch, ${redirect.redirected ? 'var(--chart-2)' : 'var(--muted)'} ${redirect.redirected ? '12%' : '100%'}, var(--card))` }}>
                  <span className="text-muted-foreground">http → https: </span>
                  {redirect.error ? <span>could not probe</span>
                    : redirect.redirected ? <span><span className="font-mono">{redirect.status}</span> → <span className="font-mono">{redirect.location}</span></span>
                    : <span>no redirect (status {redirect.status})</span>}
                </motion.div>
              )}

              {seen && <motion.div variants={item}><HeaderTable title="Request headers the origin saw" headers={seen} highlight={['host', 'x-forwarded-for', 'x-forwarded-proto', 'x-envoy-external-address', 'x-request-id']} /></motion.div>}
              {resp && <motion.div variants={item}><HeaderTable title="Response headers from the proxy" headers={resp} highlight={['strict-transport-security', 'server', 'x-envoy-upstream-service-time']} /></motion.div>}
            </motion.div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ WAF tab */

function WafTab({ base, path, item, container }: { base: string; path: string; item: Variants; container: Variants }) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState<WafRow[]>([]);
  const [note, setNote] = useState<string | null>(null);

  async function run() {
    if (!base) { setNote('Enter the proxy base URL above first.'); return; }
    setRunning(true); setNote(null); setRows([]);
    const out: WafRow[] = [];
    const attackUrl = (a: (typeof ATTACKS)[number]) => `${base}${path.startsWith('/') ? '' : '/'}${path}?${a.key}=${encodeURIComponent(a.value)}`;
    const jobs: { kind: 'attack' | 'benign'; label: string; url: string }[] = [
      ...ATTACKS.map((a) => ({ kind: 'attack' as const, label: a.label, url: attackUrl(a) })),
      ...BENIGN.map((b) => ({ kind: 'benign' as const, label: b.label, url: `${base}${b.path}` })),
    ];
    for (const j of jobs) {
      let status = 0;
      // Probe server-side: a WAF 403 (or a plain HTML 200) carries no CORS
      // headers, so a direct browser fetch cannot read its status.
      try {
        const res = await fetch(`/api/probe?url=${encodeURIComponent(j.url)}`, { cache: 'no-store' });
        const data = await res.json();
        status = typeof data.status === 'number' ? data.status : 0;
      } catch { status = 0; }
      out.push({ kind: j.kind, label: j.label, status, blocked: status === 403 });
      setRows(out.slice());
    }
    setRunning(false);
  }

  const sum = useMemo(() => {
    const atk = rows.filter((r) => r.kind === 'attack');
    const ben = rows.filter((r) => r.kind === 'benign');
    return {
      atkTotal: atk.length, atkBlocked: atk.filter((r) => r.blocked).length,
      benTotal: ben.length, benBlocked: ben.filter((r) => r.blocked).length,
    };
  }, [rows]);
  const blockRate = sum.atkTotal ? (sum.atkBlocked / sum.atkTotal) * 100 : 0;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[340px_1fr]">
      <Card>
        <CardHeader><CardTitle className="text-sm">WAF probes</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-muted-foreground text-xs">Sends {ATTACKS.length} attack payloads (XSS, SQLi, command injection, traversal) and {BENIGN.length} benign requests. A protected proxy blocks the attacks with 403 and lets the benign ones through.</p>
          <Button block loading={running} onClick={run}>Run WAF probes</Button>
          {note && <p className="text-destructive text-xs">{note}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Results</CardTitle></CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">No probes yet.</div>
          ) : (
            <motion.div className="space-y-5" variants={container} initial="hidden" animate="show">
              <motion.div variants={item} className="grid grid-cols-3 gap-2.5">
                <Stat n={<>{blockRate.toFixed(0)}<Unit>%</Unit></>} label="Attacks blocked" tone={blockRate === 100 ? 'var(--chart-2)' : 'var(--chart-5)'} />
                <Stat n={`${sum.atkBlocked}/${sum.atkTotal}`} label="Blocked / attacks" />
                <Stat n={sum.benBlocked} label="False positives" tone={sum.benBlocked ? 'var(--destructive)' : undefined} />
              </motion.div>
              <motion.div variants={item}>
                <table className="w-full text-xs tabular-nums">
                  <thead><tr className="text-muted-foreground text-left"><Th>Payload</Th><Th>Type</Th><Th>Status</Th><Th>Result</Th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i}>
                        <Td>{r.label}</Td>
                        <Td className="text-muted-foreground">{r.kind}</Td>
                        <Td>{r.status || 'ERR'}</Td>
                        <Td>
                          {r.kind === 'attack'
                            ? <Badge type={r.blocked ? 'info' : 'danger'}>{r.blocked ? 'blocked' : 'passed'}</Badge>
                            : <Badge type={r.blocked ? 'danger' : 'success'}>{r.blocked ? 'blocked (!)' : 'allowed'}</Badge>}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </motion.div>
            </motion.div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* --------------------------------------------------------------- Health tab */

const FAIL_STATUSES = [500, 502, 503, 504];

/**
 * A timer that holds its rate in a background tab. Page timers there are
 * throttled to about one tick a second (less after a few minutes), which
 * starved an earlier run of requests and faked an ejection. Dedicated worker
 * timers aren't throttled that way, and their messages still arrive, so the
 * run keeps its pace while you watch the portal in another tab.
 */
function startTicker(intervalMs: number, onTick: () => void): () => void {
  try {
    const source = `const id = setInterval(() => postMessage(0), ${intervalMs}); onmessage = () => clearInterval(id);`;
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const worker = new Worker(url);
    worker.onmessage = onTick;
    return () => {
      worker.postMessage('stop');
      worker.terminate();
      URL.revokeObjectURL(url);
    };
  } catch {
    const id = setInterval(onTick, intervalMs);
    return () => clearInterval(id);
  }
}
const PHASE_TINT: Record<Phase, string> = {
  baseline: 'var(--muted)',
  failing: 'color-mix(in oklch, var(--destructive) 18%, var(--card))',
  recovery: 'color-mix(in oklch, var(--chart-2) 18%, var(--card))',
};
const PHASE_LABEL: Record<Phase, string> = { baseline: 'Baseline', failing: 'Failing', recovery: 'Recovery' };

function HealthTab({
  base, target, item, container,
}: { base: string; target: (p?: string) => string; item: Variants; container: Variants }) {
  const [failTarget, setFailTarget] = useState('');
  const [failStatus, setFailStatus] = useState(503);
  const [rps, setRps] = useState(10);
  const [baselineS, setBaselineS] = useState(10);
  const [failingS, setFailingS] = useState(40);
  const [recoveryS, setRecoveryS] = useState(70);
  const [detected, setDetected] = useState<string[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [samples, setSamples] = useState<HealthSample[]>([]);
  // Settings of the run on screen, so editing the form doesn't re-analyse it.
  const [runConfig, setRunConfig] = useState<{ target: string; baselineS: number; failingS: number; totalS: number; rate: number } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const cancel = useRef(false);
  const store = useRef<HealthSample[]>([]);

  // Probe server-side: a 503 the proxy generates itself has no CORS headers,
  // so the browser couldn't read it (or tell it apart from a backend's 503).
  async function probe(url: string) {
    try {
      const res = await fetch(`/api/probe?url=${encodeURIComponent(url)}`, { cache: 'no-store' });
      const data = await res.json();
      return { status: typeof data.status === 'number' ? data.status : 0, backendId: (data.backendId as string | null) ?? null };
    } catch {
      return { status: 0, backendId: null };
    }
  }

  function requestUrl(n: number, failing: boolean, id: string) {
    const url = new URL(target());
    if (failing) {
      url.searchParams.set('fail', id);
      url.searchParams.set('failStatus', String(failStatus));
    }
    url.searchParams.set('_', String(n));
    return url.toString();
  }

  async function detect() {
    if (!base) { setNote('Enter the proxy base URL above first.'); return; }
    setDetecting(true); setNote(null);
    const results = await Promise.all(Array.from({ length: 20 }, (_, n) => probe(requestUrl(n, false, ''))));
    const ids = [...new Set(results.map((r) => r.backendId).filter((id): id is string => !!id))].sort();
    setDetected(ids);
    if (!ids.length) setNote('No backend answered. Check the proxy URL and path.');
    else if (!failTarget) setFailTarget(ids[ids.length - 1]);
    setDetecting(false);
  }

  async function run() {
    if (!base) { setNote('Enter the proxy base URL above first.'); return; }
    const id = failTarget.trim();
    if (!id) { setNote('Choose the backend to fail. Use Detect to list them.'); return; }
    const rate = Math.max(1, Math.min(50, Math.floor(rps)));
    const b = Math.max(1, Math.floor(baselineS));
    const f = Math.max(1, Math.floor(failingS));
    const r = Math.max(1, Math.floor(recoveryS));
    const totalMs = (b + f + r) * 1000;

    setRunning(true); setNote(null); setSamples([]); setElapsed(0);
    setRunConfig({ target: id, baselineS: b, failingS: f, totalS: b + f + r, rate });
    store.current = [];
    cancel.current = false;

    const start = performance.now();
    const inflight = new Set<Promise<void>>();
    let n = 0;

    await new Promise<void>((resolve) => {
      const flush = setInterval(() => {
        setSamples(store.current.slice());
        setElapsed((performance.now() - start) / 1000);
      }, 500);
      // A fixed rate, not a fixed concurrency: ejection shows up as the target's
      // share of a steady stream dropping to zero.
      const stop = startTicker(1000 / rate, () => {
        const t = performance.now() - start;
        if (cancel.current || t >= totalMs) {
          stop();
          clearInterval(flush);
          resolve();
          return;
        }
        const phase: Phase = t < b * 1000 ? 'baseline' : t < (b + f) * 1000 ? 'failing' : 'recovery';
        const index = n++;
        const job = probe(requestUrl(index, phase === 'failing', id)).then((res) => {
          store.current.push({ n: index, t, phase, backendId: res.backendId, status: res.status });
        });
        inflight.add(job);
        void job.finally(() => inflight.delete(job));
      });
    });

    await Promise.all(inflight);
    store.current.sort((a, x) => a.n - x.n);
    setSamples(store.current.slice());
    setElapsed((performance.now() - start) / 1000);
    setRunning(false);
  }

  const cfg = runConfig;
  const buckets = useMemo(
    () => (cfg ? bucketize(samples, cfg.target, cfg.totalS, cfg.baselineS, cfg.failingS) : []),
    [samples, cfg],
  );
  const verdict = useMemo(
    () => (cfg ? analyse(samples, buckets, cfg.target, cfg.baselineS, cfg.failingS, cfg.rate) : null),
    [samples, buckets, cfg],
  );
  const backends = useMemo(() => {
    const ids = new Set<string>();
    for (const s of samples) if (s.backendId) ids.add(s.backendId);
    return [...ids].sort();
  }, [samples]);
  const colorFor = (id: string) => CHART[Math.max(0, backends.indexOf(id)) % CHART.length];
  const maxBucket = Math.max(1, ...buckets.map((b) => b.total));
  const finished = !running && !!cfg && samples.length > 0;

  const perPhase = useMemo(() => {
    const phases: Phase[] = ['baseline', 'failing', 'recovery'];
    return backends.map((id) => ({
      id,
      counts: phases.map((phase) => {
        const inPhase = samples.filter((s) => s.phase === phase);
        const mine = inPhase.filter((s) => s.backendId === id);
        return { count: mine.length, share: inPhase.length ? (mine.length / inPhase.length) * 100 : 0 };
      }),
    }));
  }, [samples, backends]);

  const pct = (share: number) => `${(share * 100).toFixed(0)}%`;
  // A thin run is only inconclusive when it also lacks the evidence to decide.
  const inconclusive = !!verdict && verdict.rateTooLow && verdict.ejectedAfterS === null && !verdict.clearlyNotEjected;
  const trusted = verdict && !inconclusive ? verdict : null;
  const summary = (() => {
    if (!verdict || !cfg || !finished) return null;
    if (verdict.baselineToTarget === 0) {
      return {
        tone: 'bad' as const,
        text: `No baseline requests reached "${cfg.target}". Check the backend id${verdict.baselineBackends.length ? ` (seen: ${verdict.baselineBackends.join(', ')})` : ''}.`,
      };
    }
    // A thin run with too few failures can't tell an ejection from chance, so
    // say so rather than guess. With enough failures, the rate doesn't matter.
    if (inconclusive) {
      const rates = `${verdict.achievedRate.baseline.toFixed(1)} / ${verdict.achievedRate.failing.toFixed(1)} / ${verdict.achievedRate.recovery.toFixed(1)}`;
      return {
        tone: 'warn' as const,
        text: `Inconclusive: requests ran well below ${cfg.rate}/s (baseline / failing / recovery: ${rates} req/s), too few to judge an ejection. Run it again and keep this tab open, or raise the rate.`,
      };
    }
    if (verdict.ejectedAfterS !== null) {
      const retries = verdict.retriesWhileFailing > 0
        ? ` The proxy tried it again ${verdict.retriesWhileFailing} ${verdict.retriesWhileFailing === 1 ? 'time' : 'times'} while it was still failing.`
        : '';
      const readmit = verdict.readmittedAfterS === null
        ? ' It had not been re-admitted by the end of the run; try a longer recovery phase.'
        : ` It was re-admitted ${verdict.readmittedAfterS.toFixed(0)}s after the failures stopped.`;
      return {
        tone: 'good' as const,
        text: `Ejected: "${cfg.target}" stopped receiving traffic ${verdict.ejectedAfterS}s into the failure window, after ${verdict.failuresBeforeEject} 5xx responses.${retries}${readmit}`,
      };
    }
    return {
      tone: 'bad' as const,
      text: `Not ejected: "${cfg.target}" kept ${pct(verdict.targetShareFailing)} of requests while failing (${pct(verdict.baselineShare)} at baseline) and returned ${verdict.targetFailures} 5xx responses.`,
    };
  })();
  const toneColor = { good: 'var(--chart-2)', warn: 'var(--chart-4)', bad: 'var(--chart-5)' } as const;

  return (
    <div className="grid items-start gap-4 md:grid-cols-[340px_1fr]">
      <Card>
        <CardHeader><CardTitle className="text-sm">Health check test</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-muted-foreground text-xs">
            Makes one backend answer 5xx for a while, then watches whether the proxy stops sending it traffic (ejection) and when it comes back (re-admission). Needs outlier detection on the load balancer.
          </p>

          <div className="space-y-1.5">
            <Label htmlFor="hc-target">Backend to fail</Label>
            <div className="flex gap-2">
              <Input id="hc-target" value={failTarget} onChange={(e) => setFailTarget(e.target.value)} placeholder="backend-b" className="flex-1" disabled={running} />
              <Button theme="outline" loading={detecting} onClick={detect} disabled={running}>Detect</Button>
            </div>
            {detected.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {detected.map((id) => (
                  <button key={id} type="button" disabled={running} onClick={() => setFailTarget(id)}
                    className="rounded-md border px-2 py-0.5 font-mono text-xs transition-colors disabled:opacity-50"
                    style={failTarget === id ? { borderColor: 'var(--destructive)', background: 'color-mix(in oklch, var(--destructive) 12%, var(--card))' } : undefined}>
                    {id}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hc-rps">Requests / s</Label>
              <Input id="hc-rps" type="number" min={1} max={50} value={rps} onChange={(e) => setRps(+e.target.value)} disabled={running} />
            </div>
            <div className="space-y-1.5">
              <Label>Fail with</Label>
              <Select value={String(failStatus)} onValueChange={(v) => setFailStatus(+v)} disabled={running}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FAIL_STATUSES.map((code) => <SelectItem key={code} value={String(code)}>{code}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="hc-b">Baseline s</Label>
              <Input id="hc-b" type="number" min={1} value={baselineS} onChange={(e) => setBaselineS(+e.target.value)} disabled={running} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hc-f">Failing s</Label>
              <Input id="hc-f" type="number" min={1} value={failingS} onChange={(e) => setFailingS(+e.target.value)} disabled={running} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="hc-r">Recovery s</Label>
              <Input id="hc-r" type="number" min={1} value={recoveryS} onChange={(e) => setRecoveryS(+e.target.value)} disabled={running} />
            </div>
          </div>
          <p className="text-muted-foreground text-xs">
            The defaults suit the portal&rsquo;s defaults (eject after 5 consecutive 5xx for 30s): the failing phase outlasts one ejection so you can see it retried, and recovery outlasts the longer second ejection.
          </p>

          {!running ? (
            <Button block onClick={run}>Run health check test</Button>
          ) : (
            <Button block theme="outline" onClick={() => (cancel.current = true)}>
              Stop · {elapsed.toFixed(0)}/{cfg?.totalS ?? 0}s
            </Button>
          )}
          {samples.length > 0 && !running && (
            <Button block theme="link" onClick={() => download('alb-health-results.csv',
              'n,t_ms,phase,backendId,status\n' + samples.map((s) => `${s.n},${s.t.toFixed(0)},${s.phase},${s.backendId ?? ''},${s.status}`).join('\n'))}>
              Export CSV
            </Button>
          )}
          {note && <p className="text-destructive text-xs">{note}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-sm">Results</CardTitle></CardHeader>
        <CardContent>
          {!cfg || samples.length === 0 ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              {running ? 'Starting…' : 'No run yet. Pick a backend to fail and run the test.'}
            </div>
          ) : (
            <motion.div className="space-y-5" variants={container} initial="hidden" animate="show">
              <motion.div variants={item} className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                <Stat
                  n={trusted?.ejectedAfterS == null ? '—' : <>{trusted.ejectedAfterS}<Unit>s</Unit></>}
                  label="Ejected after"
                  tone={trusted?.ejectedAfterS != null ? 'var(--chart-2)' : undefined}
                />
                <Stat n={trusted?.failuresBeforeEject ?? '—'} label="5xx before eject" />
                <Stat
                  n={verdict ? <>{pct(verdict.targetShareFailing)}<Unit> vs {pct(verdict.baselineShare)}</Unit></> : '—'}
                  label="Share failing vs baseline"
                />
                <Stat
                  n={trusted?.readmittedAfterS == null ? '—' : <>{trusted.readmittedAfterS.toFixed(0)}<Unit>s</Unit></>}
                  label="Re-admitted after"
                />
              </motion.div>

              {summary && (
                <motion.div variants={item} className="space-y-1.5 rounded-md border px-3 py-2.5 text-sm"
                  style={{ borderColor: toneColor[summary.tone], background: `color-mix(in oklch, ${toneColor[summary.tone]} 12%, var(--card))` }}>
                  <p>{summary.text}</p>
                  {summary.tone === 'bad' && verdict && verdict.baselineToTarget > 0 && (
                    <ul className="text-muted-foreground list-disc space-y-0.5 pl-4 text-xs">
                      <li>Outlier detection is off, or its 5xx threshold is higher than the failures this run sent.</li>
                      <li>Every edge proxy counts consecutive 5xx on its own. Spread across several proxies, no single one may have seen enough in a row; a higher rate or longer failing phase helps.</li>
                      <li>Each backend on its own hostname is its own upstream. With a single endpoint, ejecting it leaves no healthy host, so the proxy may keep routing to it anyway.</li>
                    </ul>
                  )}
                  {verdict && verdict.proxy5xx > 0 && (
                    <p className="text-muted-foreground text-xs">{verdict.proxy5xx} requests got a 5xx from the proxy itself, with no backend behind it.</p>
                  )}
                </motion.div>
              )}

              <motion.div variants={item}>
                <SectionLabel>Timeline <span className="text-muted-foreground/70 normal-case">— requests per second</span></SectionLabel>
                <div className="relative flex h-36 items-end gap-px">
                  {buckets.map((b) => {
                    const segments: { key: string; value: number; color: string }[] = [
                      ...[...b.ok.entries()].map(([id, value]) => ({ key: id, value, color: colorFor(id) })),
                      { key: 'target-5xx', value: b.target5xx, color: 'var(--destructive)' },
                      { key: 'backend-5xx', value: b.backend5xx, color: 'var(--chart-5)' },
                      { key: 'proxy-5xx', value: b.proxy5xx, color: 'var(--foreground)' },
                      { key: 'errors', value: b.errors, color: 'var(--muted-foreground)' },
                    ].filter((seg) => seg.value > 0);
                    return (
                      <div key={b.second} className="flex h-full min-w-px flex-1 flex-col justify-end"
                        style={{ background: PHASE_TINT[b.phase] }}
                        title={`${b.second}s · ${PHASE_LABEL[b.phase]} · ${b.total} req · ${b.toTarget} to ${cfg.target}`}>
                        {segments.map((seg) => (
                          <div key={seg.key} style={{ height: `${(seg.value / maxBucket) * 100}%`, background: seg.color }} />
                        ))}
                      </div>
                    );
                  })}
                  {trusted?.ejectedAfterS != null && (
                    <div className="pointer-events-none absolute inset-y-0 w-px"
                      style={{ left: `${((cfg.baselineS + trusted.ejectedAfterS) / cfg.totalS) * 100}%`, background: 'var(--foreground)' }}
                      title={`Ejected at ${cfg.baselineS + trusted.ejectedAfterS}s`} />
                  )}
                </div>
                <div className="text-muted-foreground mt-1.5 flex text-[10.5px]">
                  {(['baseline', 'failing', 'recovery'] as Phase[]).map((phase) => {
                    const width = phase === 'baseline' ? cfg.baselineS : phase === 'failing' ? cfg.failingS : cfg.totalS - cfg.baselineS - cfg.failingS;
                    return <div key={phase} style={{ width: `${(width / cfg.totalS) * 100}%` }} className="truncate">{PHASE_LABEL[phase]}</div>;
                  })}
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {backends.map((id) => (
                    <span key={id} className="font-mono"><Dot color={colorFor(id)} />{id}{id === cfg.target ? ' (target)' : ''}</span>
                  ))}
                  <span><Dot color="var(--destructive)" />target 5xx</span>
                  <span><Dot color="var(--foreground)" />proxy 5xx</span>
                  {trusted?.ejectedAfterS != null && <span className="text-muted-foreground">│ ejected (no traffic where ~5 requests were expected)</span>}
                </div>
              </motion.div>

              {perPhase.length > 0 && (
                <motion.div variants={item}>
                  <SectionLabel>Share by phase</SectionLabel>
                  <table className="w-full text-xs tabular-nums">
                    <thead><tr className="text-muted-foreground text-left">
                      <Th>Backend</Th><Th>Baseline</Th><Th>Failing</Th><Th>Recovery</Th>
                    </tr></thead>
                    <tbody>
                      {perPhase.map((row) => (
                        <tr key={row.id}>
                          <Td className="font-mono"><Dot color={colorFor(row.id)} />{row.id}{row.id === cfg.target ? ' (target)' : ''}</Td>
                          {row.counts.map((c, i) => <Td key={i}>{c.count} · {c.share.toFixed(0)}%</Td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </motion.div>
              )}

              {samples.some((s) => outcomeOf(s, cfg.target) === 'error') && (
                <motion.p variants={item} className="text-muted-foreground text-xs">
                  {verdict?.errors} requests failed before a response (timeout or network error).
                </motion.p>
              )}
            </motion.div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- primitives */

function Stat({ n, label, tone }: { n: React.ReactNode; label: string; tone?: string }) {
  return (
    <div className="bg-muted rounded-md px-3 py-2.5">
      <div className="text-xl font-semibold tracking-tight tabular-nums" style={tone ? { color: tone } : undefined}>{n}</div>
      <div className="text-muted-foreground mt-0.5 text-[10.5px] font-medium uppercase tracking-wide">{label}</div>
    </div>
  );
}
function Unit({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground text-xs">{children}</span>;
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground mb-3 text-[11px] font-semibold uppercase tracking-wider">{children}</div>;
}
function Th({ children }: { children: React.ReactNode }) {
  return <th className="border-b py-1.5 pr-2 font-semibold uppercase">{children}</th>;
}
function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`border-b py-1.5 pr-2 ${className}`}>{children}</td>;
}
function Dot({ color }: { color: string }) {
  return <span className="mr-1.5 inline-block size-2.5 rounded-[3px] align-middle" style={{ background: color }} />;
}
function HeaderTable({ title, headers, highlight }: { title: string; headers: Record<string, string>; highlight: string[] }) {
  const keys = Object.keys(headers).sort((a, b) => {
    const ha = highlight.includes(a), hb = highlight.includes(b);
    if (ha !== hb) return ha ? -1 : 1;
    return a.localeCompare(b);
  });
  return (
    <div>
      <SectionLabel>{title}</SectionLabel>
      <table className="w-full text-xs">
        <tbody>
          {keys.map((k) => (
            <tr key={k}>
              <Td className="font-mono align-top" >{highlight.includes(k) ? <span className="font-semibold" style={{ color: 'var(--chart-2)' }}>{k}</span> : <span className="text-muted-foreground">{k}</span>}</Td>
              <Td className="font-mono break-all">{headers[k]}</Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
