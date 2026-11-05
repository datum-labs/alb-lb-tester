import ipaddr from 'ipaddr.js';
import { Agent, buildConnector, fetch } from 'undici';

// Fetch for URLs a caller supplies (the inspector and the probe). The
// dashboard is public and unauthenticated, so without this anyone could use
// it to reach whatever the server's network reaches: loopback, link-local
// metadata addresses, private ranges, or this app itself, nested to amplify.
//
// The check runs on the address each connection actually reaches, after DNS,
// so it covers IP literals, DNS answers that change between lookups, and every
// redirect hop alike. Only http(s) to public unicast addresses is allowed.
//
// `next dev`, or ALLOW_PRIVATE_TARGETS=1, lifts the address check, for testing
// an origin running on your own machine.

const allowPrivate = process.env.NODE_ENV === 'development' || process.env.ALLOW_PRIVATE_TARGETS === '1';

/**
 * True for public unicast addresses. IPv4-mapped IPv6 is checked as IPv4, and
 * so is NAT64 (64:ff9b::/96): Compute instances are IPv6-only and may reach
 * IPv4-only sites through it.
 */
export function isPublicAddress(address: string): boolean {
  try {
    const ip = ipaddr.process(address);
    if (ip.kind() === 'ipv6' && ip.range() === 'rfc6052') {
      const b = (ip as ipaddr.IPv6).toByteArray().slice(12);
      return new ipaddr.IPv4(b).range() === 'unicast';
    }
    return ip.range() === 'unicast';
  } catch {
    return false;
  }
}

const connect = buildConnector({});

const agent = new Agent({
  connect(opts, callback) {
    connect(opts, (err, socket) => {
      if (err) return callback(err, null);
      const address = socket.remoteAddress;
      if (!allowPrivate && (!address || !isPublicAddress(address))) {
        socket.destroy();
        return callback(new Error(`${opts.hostname} is not a public address (${address ?? 'unknown'}), refused`), null);
      }
      callback(null, socket);
    });
  },
});

/** Throws for a URL that isn't http(s); returns it parsed otherwise. */
export function parseTarget(target: string): URL {
  const url = new URL(target);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs');
  return url;
}

export function safeFetch(url: string, init: Parameters<typeof fetch>[1] = {}) {
  return fetch(url, { ...init, dispatcher: agent });
}

/** fetch errors say only "fetch failed"; the reason, a refusal included, is the cause. */
export function describeError(e: unknown): string {
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : '';
  return `${e}${cause}`;
}
