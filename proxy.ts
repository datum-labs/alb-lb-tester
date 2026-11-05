import { timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { dashboardAuth } from './app/dashboard-auth';

// Basic auth for the dashboard and its server-side tools, when DASHBOARD_AUTH
// is set. /api/whoami isn't matched, so it stays open.
export const config = {
  matcher: ['/', '/api/inspect', '/api/probe'],
};

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authorized(req: NextRequest): boolean {
  if (!dashboardAuth) return true;
  const header = req.headers.get('authorization') ?? '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Both compared every time, so a wrong user takes as long as a wrong password.
  const userOk = same(decoded.slice(0, i), dashboardAuth.user);
  const passwordOk = same(decoded.slice(i + 1), dashboardAuth.password);
  return userOk && passwordOk;
}

export function proxy(req: NextRequest) {
  if (!authorized(req)) {
    return new NextResponse('Login required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="alb-lb-tester", charset="UTF-8"' },
    });
  }
  // A browser resends a saved login with requests other sites trigger, so the
  // server-side tools only take requests from the dashboard's own pages.
  // Clients that aren't browsers, like curl, don't send Sec-Fetch-Site.
  if (dashboardAuth && req.nextUrl.pathname.startsWith('/api/')) {
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      return new NextResponse('Cross-site requests are refused', { status: 403 });
    }
  }
  return NextResponse.next();
}
