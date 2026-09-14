'use client';

import { useMemo, useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@datum-cloud/datum-ui/card';
import { Button } from '@datum-cloud/datum-ui/button';
import { Input } from '@datum-cloud/datum-ui/input';
import { Label } from '@datum-cloud/datum-ui/label';
import { Badge } from '@datum-cloud/datum-ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@datum-cloud/datum-ui/select';

type Result = {
  n: number;
  backendId: string;
  status: number;
  ok: boolean;
  ms: number;
  lbKey: string | null;
  error?: string;
};

type KeyMode = 'none' | 'constant' | 'random' | 'sequential';

const CHART = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
  'var(--chart-4)', 'var(--chart-5)',
];

function colorFor(id: string, order: string[]): string {
  const i = order.indexOf(id);
  return CHART[(i < 0 ? 0 : i) % CHART.length];
}

const KEY_MODES: { value: KeyMode; label: string }[] = [
  { value: 'none', label: 'None — plain requests' },
  { value: 'constant', label: 'Constant — same key (test stickiness)' },
  { value: 'random', label: 'Random — new key per request (test spread)' },
  { value: 'sequential', label: 'Sequential — key-0, key-1, …' },
];

function Stat({ n, label, tone }: { n: React.ReactNode; label: string; tone?: string }) {
  return (
    <div className="bg-muted rounded-md px-3 py-2.5">
      <div className="text-xl font-semibold tracking-tight tabular-nums" style={tone ? { color: tone } : undefined}>{n}</div>
      <div className="text-muted-foreground mt-0.5 text-[10.5px] font-medium uppercase tracking-wide">{label}</div>
    </div>
  );
}

export default function Page() {
  const [proxyUrl, setProxyUrl] = useState('');
  const [path, setPath] = useState('/api/whoami');
  const [count, setCount] = useState(100);
  const [concurrency, setConcurrency] = useState(10);
  const [keyMode, setKeyMode] = useState<KeyMode>('none');
  const [keyHeader, setKeyHeader] = useState('x-lb-key');
  const [keyValue, setKeyValue] = useState('session-1');
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [results, setResults] = useState<Result[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const cancel = useRef(false);

  const base = useMemo(() => proxyUrl.trim().replace(/\/+$/, ''), [proxyUrl]);

  async function run() {
    if (!base) {
      setNote('Enter the proxy base URL first, e.g. https://your-alb.datumproxy.net');
      return;
    }
    setRunning(true);
    setResults([]);
    setDone(0);
    setNote(null);
    cancel.current = false;

    const total = Math.max(1, Math.min(2000, Math.floor(count)));
    const pool = Math.max(1, Math.min(50, Math.floor(concurrency)));
    const collected: Result[] = [];
    let next = 0;

    const url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;

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
          const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}_=${n}`, {
            headers,
            cache: 'no-store',
          });
          const ms = performance.now() - t0;
          let backendId = res.headers.get('x-backend-id') ?? 'unknown';
          try {
            const j = await res.json();
            if (j && typeof j.backendId === 'string') backendId = j.backendId;
          } catch {
            /* non-JSON (e.g. WAF block page); keep header/unknown */
          }
          r = { n, backendId: res.ok ? backendId : `HTTP ${res.status}`, status: res.status, ok: res.ok, ms, lbKey };
        } catch (e) {
          r = { n, backendId: 'network error', status: 0, ok: false, ms: performance.now() - t0, lbKey, error: String(e) };
        }
        collected.push(r);
        setDone((d) => d + 1);
      }
    }

    await Promise.all(Array.from({ length: pool }, worker));
    collected.sort((a, b) => a.n - b.n);
    setResults(collected);
    setRunning(false);
  }

  const summary = useMemo(() => {
    const ok = results.filter((r) => r.ok);
    const counts = new Map<string, number>();
    for (const r of results) counts.set(r.backendId, (counts.get(r.backendId) ?? 0) + 1);
    const order = [...counts.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const backends = order.filter((id) => results.find((r) => r.backendId === id && r.ok));
    const lat = ok.map((r) => r.ms).sort((a, b) => a - b);
    const pct = (p: number) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))] : 0);
    return {
      counts,
      order,
      backends,
      total: results.length,
      okCount: ok.length,
      errCount: results.length - ok.length,
      uniqueBackends: backends.length,
      p50: pct(50),
      p95: pct(95),
      max: lat.length ? lat[lat.length - 1] : 0,
    };
  }, [results]);

  const stickyVerdict = useMemo(() => {
    if (keyMode !== 'constant' || summary.okCount === 0) return null;
    const okBackends = new Set(results.filter((r) => r.ok).map((r) => r.backendId));
    if (okBackends.size === 1) {
      return { good: true, text: `Sticky: all ${summary.okCount} requests with the same ${keyHeader} landed on "${[...okBackends][0]}". Consistent-hash routing is working.` };
    }
    return { good: false, text: `Not sticky: a constant ${keyHeader} was spread across ${okBackends.size} backends. Expected one backend if the proxy uses ConsistentHash on that header.` };
  }, [keyMode, results, summary.okCount, keyHeader]);

  const maxCount = Math.max(1, ...[...summary.counts.values()]);

  return (
    <div className="mx-auto max-w-5xl px-5 pb-16 pt-10">
      <header className="mb-7">
        <h1 className="text-xl font-semibold tracking-tight">ALB Load-Balancer Tester</h1>
        <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
          Fire traffic through a Datum HTTPProxy and watch which backend serves each request. Tests weighted backends and load-balancing algorithms.
        </p>
      </header>

      <div className="grid items-start gap-4 md:grid-cols-[340px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Configuration</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="proxy">Proxy base URL</Label>
              <Input id="proxy" value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="https://your-alb.datumproxy.net" />
              <p className="text-muted-foreground text-xs">Your HTTPProxy hostname. Its rule should point at two or more whoami backends.</p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="path">Request path</Label>
              <Input id="path" value={path} onChange={(e) => setPath(e.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="count">Requests</Label>
                <Input id="count" type="number" min={1} max={2000} value={count} onChange={(e) => setCount(+e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="conc">Concurrency</Label>
                <Input id="conc" type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Hash key mode</Label>
              <Select value={keyMode} onValueChange={(v) => setKeyMode(v as KeyMode)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KEY_MODES.map((m) => (
                    <SelectItem key={m.value} value={m.value}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground text-xs">
                For a ConsistentHash-on-Header proxy: use Constant to confirm one backend, Random to confirm the hash spreads across backends.
              </p>
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

            <Button block loading={running} onClick={run} disabled={running}>
              {running ? `Running… ${done}/${count}` : 'Send traffic'}
            </Button>
            {running && (
              <Button block theme="outline" onClick={() => (cancel.current = true)}>Stop</Button>
            )}
            {note && <p className="text-destructive text-xs">{note}</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Results</CardTitle>
          </CardHeader>
          <CardContent>
            {results.length === 0 ? (
              <div className="text-muted-foreground py-12 text-center text-sm">No traffic yet. Configure a proxy URL and send requests.</div>
            ) : (
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  <Stat n={summary.total} label="Requests" />
                  <Stat n={summary.okCount} label="OK" tone="var(--chart-2)" />
                  <Stat n={summary.errCount} label="Errors" tone={summary.errCount ? 'var(--destructive)' : undefined} />
                  <Stat n={summary.uniqueBackends} label="Backends" />
                </div>

                <div className="grid grid-cols-3 gap-2.5">
                  <Stat n={<>{summary.p50.toFixed(0)}<span className="text-muted-foreground text-xs">ms</span></>} label="p50 latency" />
                  <Stat n={<>{summary.p95.toFixed(0)}<span className="text-muted-foreground text-xs">ms</span></>} label="p95 latency" />
                  <Stat n={<>{summary.max.toFixed(0)}<span className="text-muted-foreground text-xs">ms</span></>} label="max latency" />
                </div>

                {stickyVerdict && (
                  <div
                    className="rounded-md border px-3 py-2.5 text-sm"
                    style={{
                      borderColor: stickyVerdict.good ? 'var(--chart-2)' : 'var(--warning, var(--chart-5))',
                      background: `color-mix(in oklch, ${stickyVerdict.good ? 'var(--chart-2)' : 'var(--chart-5)'} 12%, var(--card))`,
                    }}
                  >
                    {stickyVerdict.text}
                  </div>
                )}

                <div>
                  <div className="text-muted-foreground mb-3 text-[11px] font-semibold uppercase tracking-wider">Distribution</div>
                  <div className="space-y-2">
                    {summary.order.map((id) => {
                      const c = summary.counts.get(id) ?? 0;
                      const share = (c / summary.total) * 100;
                      const isErr = !results.find((r) => r.backendId === id && r.ok);
                      return (
                        <div className="flex items-center gap-3" key={id}>
                          <div className="w-[150px] truncate font-mono text-xs" title={id}>{id}</div>
                          <div className="bg-muted h-6 flex-1 overflow-hidden rounded">
                            <div
                              className="h-full rounded transition-[width] duration-300 ease-out"
                              style={{ width: `${(c / maxCount) * 100}%`, minWidth: 3, background: isErr ? 'var(--destructive)' : colorFor(id, summary.backends) }}
                            />
                          </div>
                          <div className="text-muted-foreground w-24 text-right text-xs tabular-nums">{c} · {share.toFixed(1)}%</div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div>
                  <div className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-wider">Request log</div>
                  <div className="max-h-80 overflow-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground text-left">
                          <th className="border-b py-1.5 pr-2 font-semibold uppercase">#</th>
                          <th className="border-b px-2 py-1.5 font-semibold uppercase">Backend</th>
                          <th className="border-b px-2 py-1.5 font-semibold uppercase">Status</th>
                          <th className="border-b px-2 py-1.5 font-semibold uppercase">ms</th>
                          <th className="border-b px-2 py-1.5 font-semibold uppercase">Key</th>
                        </tr>
                      </thead>
                      <tbody className="tabular-nums">
                        {results.slice(-200).reverse().map((r) => (
                          <tr key={r.n}>
                            <td className="border-b py-1.5 pr-2">{r.n}</td>
                            <td className="border-b px-2 py-1.5 font-mono">
                              {r.ok && (
                                <span className="mr-1.5 inline-block size-2.5 rounded-[3px] align-middle" style={{ background: colorFor(r.backendId, summary.backends) }} />
                              )}
                              {r.backendId}
                            </td>
                            <td className="border-b px-2 py-1.5">
                              <Badge type={r.ok ? 'success' : 'danger'}>{r.status || 'ERR'}</Badge>
                            </td>
                            <td className="border-b px-2 py-1.5">{r.ms.toFixed(0)}</td>
                            <td className="border-b px-2 py-1.5 font-mono">{r.lbKey ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
