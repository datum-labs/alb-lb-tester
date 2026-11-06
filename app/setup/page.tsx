import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Card, CardContent, CardHeader, CardTitle } from '@datum-cloud/datum-ui/card';
import { originOnly } from '../origin-only';
import { Deployments, Legend, TrafficPaths } from './diagrams';

// What runs where. Gated like the dashboard: 404 under ORIGIN_ONLY, and
// behind DASHBOARD_AUTH when that's set (see proxy.ts).
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Setup · ALB Load-Balancer Tester',
};

const IMAGE = 'ghcr.io/datum-labs/alb-lb-tester';

export default function SetupPage() {
  if (originOnly) notFound();

  return (
    <div className="mx-auto max-w-5xl px-5 pb-16 pt-10">
      <header className="mb-7 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Setup</h1>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm">
            What to run where, before you test a Datum HTTPProxy with this tool.
          </p>
        </div>
        <Link href="/" className="bg-card hover:bg-muted shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-medium transition-colors">
          &larr; Dashboard
        </Link>
      </header>

      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle className="text-sm">The parts</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <Part term="The dashboard">
                The page you use. It runs a test against the proxy and charts which origin answered each request. Some tests send their requests from the dashboard&rsquo;s server, some from your browser (see below).
              </Part>
              <Part term="The origins">
                Instances of this same app, behind the proxy under test. Each answers <Code>/api/whoami</Code> with its <Code>backendId</Code> (set by <Code>BACKEND_ID</Code>) and <Code>instanceId</Code>, so the dashboard can tell who served a request. A query like <Code>?fail=&lt;backendId&gt;</Code> makes one of them fail on request.
              </Part>
              <Part term="The proxy under test">
                A Datum HTTPProxy whose backends are the origins. Its rules, weights, load-balancing algorithm and health checks are what you&rsquo;re testing.
              </Part>
              <Part term="Proxy base URL">
                The field at the top of the dashboard. Enter the proxy&rsquo;s scheme and hostname only, such as <Code>https://&lt;id&gt;.datumproxy.net</Code> or a custom hostname on the proxy; the path goes in <em>Request path</em> (default <Code>/api/whoami</Code>). Not an origin&rsquo;s own URL, or the test skips the proxy.
              </Part>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Where test traffic flows</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">
              <strong>Send test traffic from: Server | Browser</strong>, under the proxy URL, picks who sends the test requests.
            </p>
            <div>
              <TrafficPaths />
              <Legend />
            </div>
            <ul className="text-muted-foreground list-disc space-y-1.5 pl-5 text-sm">
              <li>
                <span className="text-foreground font-medium">Server</span> reads every status and header, sends any header, and works whatever CORS headers the answer has. It needs the dashboard&rsquo;s server to reach the proxy.
              </li>
              <li>
                <span className="text-foreground font-medium">Browser</span> sends from your machine, without cookies or a saved login. A browser can&rsquo;t send some headers (<Code>Cookie</Code>, <Code>Host</Code>, <Code>Origin</Code>, ...) or read <Code>Set-Cookie</Code>, and reads an answer from another origin only when it has CORS headers. <Code>/api/whoami</Code> always sends them; an answer the proxy makes itself (a WAF block page, its own timeout) doesn&rsquo;t, and is reported as unreadable.
              </li>
              <li>
                <span className="text-foreground font-medium">Automatic check.</span> When you enter a proxy URL, the dashboard asks its server to send one request to that host (3s timeout). If no answer comes back, tests switch to Browser and a note says why. You can switch back any time; your choice stands until you change the host.
              </li>
            </ul>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <Th>Tab</Th><Th>Sent from</Th><Th>Path</Th>
                  </tr>
                </thead>
                <tbody>
                  <Row tab="Load balancing" from="Always your browser" path="Browser → proxy → origins" />
                  <Row tab="Headers & redirect" from="The toggle" path="Server: dashboard server → proxy → origins. Browser: some headers are server only." />
                  <Row tab="WAF probes" from="The toggle" path="Same as above" />
                  <Row tab="Health checks" from="The toggle" path="Same as above" />
                  <Row tab="Timeouts & retries" from="The toggle" path="Same as above" />
                  <Row
                    tab="Sticky failure"
                    from="Always the server"
                    path="Dashboard server → each instance directly, by its internal name, not through the proxy. Only shown behind DASHBOARD_AUTH."
                  />
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Three ways to run it</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Deployments />
              <Legend blocked />
            </div>
            <div className="grid gap-4 text-sm lg:grid-cols-3">
              <Part term="Local or another cloud">
                The dashboard runs on your machine or a VM outside Datum; the origins run on Datum Compute behind your HTTPProxy. The dashboard&rsquo;s server can reach the proxy, so tests stay in Server mode. Sticky failure can&rsquo;t reach the instances from outside Datum, since it uses their internal names.
              </Part>
              <Part term="Hosted on Datum Compute">
                One Compute workload is both the dashboard (behind <Code>DASHBOARD_AUTH</Code>) and the origins. A dashboard on Datum Compute can&rsquo;t currently reach Datum proxies, so proxy tests run in Browser mode, which the automatic check picks for you. Sticky failure, and the inspector or probe aimed at an instance&rsquo;s internal name, work from the server.
              </Part>
              <Part term="CI origin only">
                <Code>ORIGIN_ONLY=1</Code>: an origin for automated load-balancing tests. Only <Code>/api/whoami</Code> answers; the dashboard, this page and the server-side tools return 404.
              </Part>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Settings</CardTitle></CardHeader>
          <CardContent>
            <p className="text-muted-foreground mb-3 text-sm">Environment variables, all optional.</p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-xs">
                <thead>
                  <tr className="text-muted-foreground text-left">
                    <Th>Variable</Th><Th>When to use it</Th>
                  </tr>
                </thead>
                <tbody>
                  <Setting name="BACKEND_ID" use="Name each origin deployment, such as backend-a, backend-b, so the charts tell them apart. Without it, a deployment is named by its Vercel hostname, or local." />
                  <Setting name="INSTANCE_ID" use="Name an instance yourself. Without it, each instance picks a random id when it starts." />
                  <Setting name="DASHBOARD_AUTH" use="user:password. Puts the dashboard, this page and the server-side tools behind a login, lets them reach *.datum.internal names, and turns on Sticky failure. Use it for any dashboard on a public URL. /api/whoami stays open." />
                  <Setting name="ORIGIN_ONLY" use="1 for a deployment that is only an origin: /api/whoami answers, everything else returns 404." />
                  <Setting name="ALLOW_PRIVATE_TARGETS" use="1 to let the server-side tools reach private and loopback addresses, for an origin on your own machine. npm run dev already allows this. Leave it off anywhere public." />
                  <Setting name="HOSTNAME" use="The address the server binds. The Compute image already binds :: (Compute instances are IPv6-only); set HOSTNAME=:: only for an image built before that." />
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="text-sm">Quick start</CardTitle></CardHeader>
          <CardContent className="space-y-6 text-sm">
            <section className="space-y-2">
              <SectionLabel>Origins on Datum Compute (all setups)</SectionLabel>
              <p>
                Deploy the tester as a Compute workload with 3 instances. Add <Code>--env ORIGIN_ONLY=1</Code> when nobody will open a dashboard on it (the local and CI setups), or <Code>--env DASHBOARD_AUTH=&lt;user&gt;:&lt;password&gt;</Code> to host the dashboard on it. A project without a network named <Code>default</Code> needs <Code>--network &lt;name&gt; --yes</Code>.
              </p>
              <Pre>{`datumctl compute deploy alb-lb-tester --project <project> \\
  --image ${IMAGE}:container-latest --runtime-class general-purpose \\
  --location <location> --min 3 --http-port 3000 \\
  --env BACKEND_ID=compute`}</Pre>
              <p>
                Then point an HTTPProxy at the workload&rsquo;s NetworkService. Look up its name and port with <Code>datumctl get networkservices --project &lt;project&gt;</Code>; more manifests are in the repository&rsquo;s <Code>examples/</Code> folder.
              </p>
              <Pre>{`# httpproxy.yaml
apiVersion: networking.datumapis.com/v1alpha
kind: HTTPProxy
metadata:
  name: lb-tester
spec:
  rules:
    - backends:
        - networkService:
            name: alb-lb-tester
            port: http`}</Pre>
              <Pre>{`datumctl apply -f httpproxy.yaml --project <project>

# the hostname to enter as the proxy base URL: status.canonicalHostname
datumctl get httpproxy lb-tester --project <project> -o yaml`}</Pre>
            </section>

            <section className="space-y-2">
              <SectionLabel>Local or another cloud</SectionLabel>
              <p>Run the dashboard from a checkout, or from the container image, then open it and enter the proxy&rsquo;s URL.</p>
              <Pre>{`npm ci
npm run dev        # http://localhost:3000

# or, without Node:
docker run -p 3000:3000 -e BACKEND_ID=local ${IMAGE}:container-latest`}</Pre>
            </section>

            <section className="space-y-2">
              <SectionLabel>Hosted on Datum Compute</SectionLabel>
              <p>
                Deploy the origins as above with a login. Every instance needs the same <Code>DASHBOARD_AUTH</Code>, since Sticky failure sends your login to each one. Open the URL the deploy prints, log in, and enter the proxy&rsquo;s URL; tests switch to Browser mode on their own.
              </p>
              <Pre>{`datumctl compute deploy alb-lb-tester --project <project> \\
  --image ${IMAGE}:container-latest --runtime-class general-purpose \\
  --location <location> --min 3 --http-port 3000 \\
  --env BACKEND_ID=compute --env DASHBOARD_AUTH=<user>:<password>`}</Pre>
              <p>
                For Sticky failure, enter the instance prefix <Code>&lt;workload&gt;-&lt;network&gt;-&lt;location&gt;</Code> and the instance count on its tab.
              </p>
            </section>

            <section className="space-y-2">
              <SectionLabel>CI origin only</SectionLabel>
              <p>Same workload with <Code>ORIGIN_ONLY=1</Code> and no login, behind the HTTPProxy your tests call.</p>
              <Pre>{`datumctl compute deploy alb-lb-tester --project <project> \\
  --image ${IMAGE}:container-latest --runtime-class general-purpose \\
  --location <location> --min 3 --http-port 3000 \\
  --env BACKEND_ID=compute --env ORIGIN_ONLY=1

curl https://<proxy-hostname>/api/whoami`}</Pre>
            </section>

            <p className="text-muted-foreground text-xs">
              These commands use the <Code>container-latest</Code> image on Compute&rsquo;s <Code>general-purpose</Code> runtime. To move an existing workload to a newer build, deploy it with that build&rsquo;s <Code>container-sha-&lt;commit&gt;</Code> tag: Compute keeps running the image it already pulled for an unchanged tag. The README has the full reference.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Part({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{term}</dt>
      <dd className="text-muted-foreground mt-1">{children}</dd>
    </div>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="bg-muted rounded px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
}

function Pre({ children }: { children: string }) {
  return <pre className="bg-muted overflow-x-auto rounded-md px-3 py-2.5 font-mono text-xs leading-relaxed">{children}</pre>;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground text-[11px] font-semibold uppercase tracking-wider">{children}</div>;
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="border-b py-1.5 pr-2 font-semibold uppercase">{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`border-b py-1.5 pr-2 align-top ${className}`}>{children}</td>;
}

function Row({ tab, from, path }: { tab: string; from: string; path: string }) {
  return (
    <tr>
      <Td className="font-medium whitespace-nowrap">{tab}</Td>
      <Td className="whitespace-nowrap">{from}</Td>
      <Td className="text-muted-foreground">{path}</Td>
    </tr>
  );
}

function Setting({ name, use }: { name: string; use: string }) {
  return (
    <tr>
      <Td className="font-mono whitespace-nowrap">{name}</Td>
      <Td className="text-muted-foreground">{use}</Td>
    </tr>
  );
}
