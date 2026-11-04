/**
 * Analysis for the header comparison on the Headers tab.
 *
 * One request through the proxy gives four sets of headers:
 *   request leg   — what the client sent, and what the origin received
 *   response leg  — what the origin sent back, and what the client received
 *
 * Comparing each pair shows what the edge did. Some headers change at every
 * hop no matter who's in the middle (framing, connection handling, Date), so
 * they're kept apart instead of being blamed on the edge.
 */

export type Change = 'unchanged' | 'added' | 'removed' | 'rewritten' | 'appended';

export type HeaderRow = {
  name: string;
  before: string | null;
  after: string | null;
  change: Change;
  /** Changes at every hop; not evidence of what the edge did. */
  hop: boolean;
};

/** Headers that legitimately change between any two hops. */
export const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'date',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
]);

/**
 * Headers a client may not send and an origin may not be asked to send: they
 * describe the connection or the body's framing, so setting them breaks the
 * request instead of testing the edge.
 */
export const UNSETTABLE_HEADERS = new Set([
  ...HOP_HEADERS,
  'host',
  'expect',
  'content-type',
]);

// RFC 9110 token characters.
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export const MAX_CUSTOM_HEADERS = 20;
export const MAX_CUSTOM_VALUE = 1024;

export type ParsedHeaders = { headers: [string, string][]; rejected: { line: string; reason: string }[] };

/**
 * Parses `Name: Value` lines (or `Name:Value` query values). Names are
 * lowercased, as HTTP/2 sends them. Repeated names are kept, in order, so
 * several Set-Cookie headers can be asked for.
 */
export function parseHeaderLines(lines: string[]): ParsedHeaders {
  const headers: [string, string][] = [];
  const rejected: { line: string; reason: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i <= 0) { rejected.push({ line, reason: 'expected Name: Value' }); continue; }
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    if (!TOKEN.test(name)) rejected.push({ line, reason: 'not a valid header name' });
    else if (UNSETTABLE_HEADERS.has(name)) rejected.push({ line, reason: 'framing or connection header, can\'t be set' });
    else if (/[\r\n\0]/.test(value) || value.length > MAX_CUSTOM_VALUE) rejected.push({ line, reason: `value must be one line, at most ${MAX_CUSTOM_VALUE} characters` });
    else if (headers.length >= MAX_CUSTOM_HEADERS) rejected.push({ line, reason: `at most ${MAX_CUSTOM_HEADERS} headers` });
    else headers.push([name, value]);
  }
  return { headers, rejected };
}

/**
 * Folds header pairs into one value per name, the way they arrive on the
 * other side: comma-joined, except Set-Cookie, which can't be joined and is
 * kept one per line.
 */
export function foldHeaders(pairs: Iterable<[string, string]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const name = k.toLowerCase();
    if (!(name in out)) out[name] = v;
    else out[name] += name === 'set-cookie' ? `\n${v}` : `, ${v}`;
  }
  return out;
}

/** Same as foldHeaders, for a fetch Headers object (keeps Set-Cookie apart). */
export function headersObject(h: Headers): Record<string, string> {
  const pairs: [string, string][] = [];
  h.forEach((v, k) => { if (k !== 'set-cookie') pairs.push([k, v]); });
  for (const c of h.getSetCookie()) pairs.push(['set-cookie', c]);
  return foldHeaders(pairs);
}

const listOf = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);

function classify(before: string | null, after: string | null): Change {
  if (before === null) return 'added';
  if (after === null) return 'removed';
  if (before === after) return 'unchanged';
  const b = listOf(before), a = listOf(after);
  if (a.length > b.length && b.every((x, i) => a[i] === x)) return 'appended';
  return 'rewritten';
}

/**
 * Compares one leg: the headers on the way in against the way out. `alsoHop`
 * names more headers to keep apart, such as ones the origin's runtime adds
 * after it reports what it sent.
 */
export function diffHeaders(before: Record<string, string>, after: Record<string, string>, alsoHop: string[] = []): HeaderRow[] {
  const names = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...names]
    .map((name) => {
      const b = before[name] ?? null, a = after[name] ?? null;
      return { name, before: b, after: a, change: classify(b, a), hop: HOP_HEADERS.has(name) || alsoHop.includes(name) };
    })
    .sort((x, y) => Number(x.hop) - Number(y.hop) || Number(x.change === 'unchanged') - Number(y.change === 'unchanged') || x.name.localeCompare(y.name));
}

/* ---------------------------------------------------- Forwarding headers */

/**
 * Fake forwarding headers for the "client address" preset. Addresses are from
 * TEST-NET-3 (RFC 5737), so a real client can never have them.
 */
export const SPOOFED_FORWARDING: [string, string][] = [
  ['x-forwarded-for', '203.0.113.7'],
  ['x-real-ip', '203.0.113.8'],
  ['x-envoy-external-address', '203.0.113.9'],
  ['true-client-ip', '203.0.113.10'],
  ['forwarded', 'for=203.0.113.11;proto=http'],
  ['x-forwarded-proto', 'http'],
  ['x-forwarded-host', 'spoofed.example'],
];

/** Headers that might carry the client address, most trusted first. */
const ADDRESS_HEADERS = ['x-envoy-external-address', 'x-real-ip', 'true-client-ip', 'x-forwarded-for', 'forwarded'];

export type ForwardingFinding = {
  name: string;
  sent: string | null;
  received: string | null;
  /** What a client can do with this header through the edge. */
  verdict: 'set by edge' | 'overwritten' | 'appended' | 'passed through' | 'removed' | 'absent';
};

export type ForwardingReport = {
  findings: ForwardingFinding[];
  /** The address the edge vouches for: a spoofed header it replaced. */
  clientAddress: string | null;
  /** Plain-language answer: where an app should read the client address. */
  answer: string;
};

/**
 * Reads the request leg of a run that sent the spoofed forwarding headers,
 * and says which header an app can trust for the client address.
 */
export function forwardingReport(sent: Record<string, string>, received: Record<string, string>): ForwardingReport {
  const findings: ForwardingFinding[] = [...new Set([...SPOOFED_FORWARDING.map(([n]) => n), ...ADDRESS_HEADERS])].map((name) => {
    const s = sent[name] ?? null, r = received[name] ?? null;
    let verdict: ForwardingFinding['verdict'];
    if (s === null) verdict = r === null ? 'absent' : 'set by edge';
    else if (r === null) verdict = 'removed';
    else if (r === s) verdict = 'passed through';
    else if (classify(s, r) === 'appended') verdict = 'appended';
    else if (listOf(r).includes(s)) verdict = 'passed through';
    else verdict = 'overwritten';
    return { name, sent: s, received: r, verdict };
  });

  const trusted = ADDRESS_HEADERS
    .map((n) => findings.find((f) => f.name === n)!)
    .find((f) => (f.verdict === 'overwritten' || f.verdict === 'set by edge') && f.name !== 'forwarded' && f.received);
  const clientAddress = trusted ? listOf(trusted.received!).at(-1)! : null;

  const parts: string[] = [];
  if (trusted) parts.push(`Read the client address from ${trusted.name}: the edge sets it and replaced the fake value.`);
  else parts.push('No forwarding header carried an address the edge vouches for.');

  const xff = findings.find((f) => f.name === 'x-forwarded-for')!;
  if (xff.verdict === 'appended' && clientAddress) {
    const entries = listOf(xff.received!);
    const fromEnd = entries.length - 1 - entries.lastIndexOf(clientAddress);
    parts.push(fromEnd === 0
      ? 'X-Forwarded-For keeps whatever the client sent and adds the real address last: read the last entry, never the first.'
      : `X-Forwarded-For keeps whatever the client sent; the real address is entry ${fromEnd + 1} from the end, never the first.`);
  } else if (xff.verdict === 'appended') {
    parts.push('X-Forwarded-For keeps whatever the client sent and the edge adds entries after it: read from the end, never the first entry.');
  } else if (xff.verdict === 'passed through') {
    parts.push('X-Forwarded-For arrives exactly as the client sent it: don\'t trust it.');
  } else if (xff.verdict === 'overwritten') {
    parts.push('X-Forwarded-For is replaced by the edge, so it can be trusted too.');
  } else if (xff.verdict === 'removed') {
    parts.push('X-Forwarded-For is removed: apps that read it get nothing.');
  }

  const spoofable = findings.filter((f) => f.verdict === 'passed through' && f.name !== 'x-forwarded-for').map((f) => f.name);
  if (spoofable.length) parts.push(`A client can set ${spoofable.join(', ')} to anything.`);

  return { findings, clientAddress, answer: parts.join(' ') };
}

/* ------------------------------------------------------------- Evidence */

const cell = (v: string | null) => (v === null ? '—' : `\`${v.replace(/\n/g, ' ⏎ ').replace(/\|/g, '\\|')}\``);

function legTable(rows: HeaderRow[]): string {
  const changed = rows.filter((r) => !r.hop && r.change !== 'unchanged');
  if (!changed.length) return '_No changes._\n';
  return ['| Header | Change | Before | After |', '|---|---|---|---|',
    ...changed.map((r) => `| \`${r.name}\` | ${r.change} | ${cell(r.before)} | ${cell(r.after)} |`)].join('\n') + '\n';
}

/** A short markdown summary to paste into a ticket or docs PR. */
export function evidenceMarkdown(opts: {
  at: Date;
  target: string;
  status: number;
  request: HeaderRow[];
  response: HeaderRow[] | null;
  forwarding: ForwardingReport | null;
  /** False when the origin couldn't report request headers as they arrived. */
  rawRequest: boolean;
}): string {
  const out = [
    `**Header check** · ${opts.at.toISOString()} · \`${opts.target}\` · status ${opts.status}`,
    '',
    '**Request: client sent → origin received** (edge changes only; per-hop headers left out)',
    '',
    legTable(opts.request),
    ...(opts.rawRequest ? [] : ['_The origin reported request headers after its runtime filled in missing X-Forwarded-*; those may not come from the edge._', '']),
    '**Response: origin sent → client received**',
    '',
    opts.response ? legTable(opts.response) : '_The origin didn\'t report what it sent._\n',
  ];
  if (opts.forwarding) out.push('**Client address:** ' + opts.forwarding.answer, '');
  out.push('_Measured with alb-lb-tester. Shows what the edge did on this request, not what is guaranteed._');
  return out.join('\n');
}
