'use client';

import { useMemo, useRef, useState } from 'react';

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

// Datum chart palette (from datum-ui alpha.css --chart-1..5), cycled.
const PALETTE = [
  'var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)',
];

function colorFor(id: string, order: string[]): string {
  const i = order.indexOf(id);
  return PALETTE[(i < 0 ? 0 : i) % PALETTE.length];
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
    <div className="wrap">
      <header>
        <h1>ALB Load-Balancer Tester</h1>
        <p>Fire traffic through a Datum HTTPProxy and watch which backend serves each request. Tests weighted backends and load-balancing algorithms.</p>
      </header>

      <div className="grid">
        <div className="card">
          <h2>Configuration</h2>

          <label>Proxy base URL</label>
          <input value={proxyUrl} onChange={(e) => setProxyUrl(e.target.value)} placeholder="https://your-alb.datumproxy.net" />
          <div className="hint">Your HTTPProxy hostname. Its rule should point at two or more whoami backends.</div>

          <label>Request path</label>
          <input value={path} onChange={(e) => setPath(e.target.value)} />

          <div className="row">
            <div>
              <label>Requests</label>
              <input type="number" min={1} max={2000} value={count} onChange={(e) => setCount(+e.target.value)} />
            </div>
            <div>
              <label>Concurrency</label>
              <input type="number" min={1} max={50} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} />
            </div>
          </div>

          <label>Hash key mode</label>
          <select value={keyMode} onChange={(e) => setKeyMode(e.target.value as KeyMode)}>
            <option value="none">None — plain requests</option>
            <option value="constant">Constant — same key every request (test stickiness)</option>
            <option value="random">Random — new key per request (test hash spread)</option>
            <option value="sequential">Sequential — key-0, key-1, …</option>
          </select>
          <div className="hint">
            For a ConsistentHash-on-Header proxy: use Constant to confirm one backend, Random to confirm the hash spreads across backends.
          </div>

          {keyMode !== 'none' && (
            <div className="row">
              <div>
                <label>Header name</label>
                <input value={keyHeader} onChange={(e) => setKeyHeader(e.target.value)} />
              </div>
              <div>
                <label>Key value</label>
                <input value={keyValue} onChange={(e) => setKeyValue(e.target.value)} disabled={keyMode === 'random'} />
              </div>
            </div>
          )}

          <button className="run" onClick={run} disabled={running}>
            {running ? `Running… ${done}/${count}` : 'Send traffic'}
          </button>
          {running && (
            <button className="ghost" onClick={() => (cancel.current = true)}>Stop</button>
          )}
          {note && <div className="hint" style={{ color: 'var(--warn)', marginTop: 10 }}>{note}</div>}
        </div>

        <div className="card">
          <h2>Results</h2>

          {results.length === 0 ? (
            <div className="empty">No traffic yet. Configure a proxy URL and send requests.</div>
          ) : (
            <>
              <div className="stats">
                <div className="stat"><div className="n">{summary.total}</div><div className="l">Requests</div></div>
                <div className="stat"><div className="n" style={{ color: 'var(--good)' }}>{summary.okCount}</div><div className="l">OK</div></div>
                <div className="stat"><div className="n" style={{ color: summary.errCount ? 'var(--bad)' : undefined }}>{summary.errCount}</div><div className="l">Errors</div></div>
                <div className="stat"><div className="n">{summary.uniqueBackends}</div><div className="l">Backends</div></div>
              </div>

              <div className="stats" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
                <div className="stat"><div className="n">{summary.p50.toFixed(0)}<span style={{ fontSize: 12, color: 'var(--muted)' }}>ms</span></div><div className="l">p50 latency</div></div>
                <div className="stat"><div className="n">{summary.p95.toFixed(0)}<span style={{ fontSize: 12, color: 'var(--muted)' }}>ms</span></div><div className="l">p95 latency</div></div>
                <div className="stat"><div className="n">{summary.max.toFixed(0)}<span style={{ fontSize: 12, color: 'var(--muted)' }}>ms</span></div><div className="l">max latency</div></div>
              </div>

              {stickyVerdict && (
                <div className={`verdict ${stickyVerdict.good ? 'good' : 'warn'}`}>{stickyVerdict.text}</div>
              )}

              <h2 style={{ marginTop: 4 }}>Distribution</h2>
              {summary.order.map((id) => {
                const c = summary.counts.get(id) ?? 0;
                const share = (c / summary.total) * 100;
                const isErr = !results.find((r) => r.backendId === id && r.ok);
                return (
                  <div className="bar-row" key={id}>
                    <div className="bar-label" title={id}>{id}</div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(c / maxCount) * 100}%`, background: isErr ? 'var(--bad)' : colorFor(id, summary.backends) }} />
                    </div>
                    <div className="bar-num">{c} · {share.toFixed(1)}%</div>
                  </div>
                );
              })}

              <h2 style={{ marginTop: 20 }}>Request log</h2>
              <div className="scroll">
                <table>
                  <thead>
                    <tr><th>#</th><th>Backend</th><th>Status</th><th>ms</th><th>Key</th></tr>
                  </thead>
                  <tbody>
                    {results.slice(-200).reverse().map((r) => (
                      <tr key={r.n}>
                        <td>{r.n}</td>
                        <td className="mono">
                          {r.ok && <span className="legend-dot" style={{ background: colorFor(r.backendId, summary.backends) }} />}
                          {r.backendId}
                        </td>
                        <td><span className={`pill ${r.ok ? 'ok' : 'err'}`}>{r.status || 'ERR'}</span></td>
                        <td>{r.ms.toFixed(0)}</td>
                        <td className="mono">{r.lbKey ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
