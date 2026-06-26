import http from 'node:http';
import type { AddressInfo } from 'node:net';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerVncProxy } from '../src/vncProxy.js';

// noVNC's vnc_lite.html loads its JS/CSS via relative URLs that DROP the
// `?ticket=` query (ES-module + stylesheet sub-requests). The /vnc proxy must
// still authorize those: the ticketed page load plants a `vnc_ticket` cookie
// and the asset requests that follow ride on it. Otherwise every sub-resource
// 403s and noVNC hangs on "Loading" — the NAS bug this guards against.
describe('registerVncProxy — static asset gating', () => {
  let upstream: http.Server;
  let app: ReturnType<typeof Fastify>;
  let base: string;

  beforeAll(async () => {
    // Stand-in for websockify --web: 200s every path so we only assert gating.
    upstream = http.createServer((rq, rs) => {
      rs.writeHead(200, { 'content-type': 'text/javascript' });
      rs.end(`upstream ${rq.url}`);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const upstreamPort = (upstream.address() as AddressInfo).port;

    app = Fastify();
    registerVncProxy(app, { upstreamPort, validateTicket: (t) => t === 'good' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app.close();
    upstream.close();
  });

  it('403s an asset with no ticket and no cookie', async () => {
    const res = await fetch(`${base}/vnc/core/rfb.js`);
    expect(res.status).toBe(403);
  });

  it('serves the page with a query ticket and plants a vnc_ticket cookie', async () => {
    const res = await fetch(`${base}/vnc/vnc_lite.html?ticket=good`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/vnc_ticket=good/);
  });

  it('serves a ticket-less asset when the vnc_ticket cookie is valid', async () => {
    const res = await fetch(`${base}/vnc/core/rfb.js`, {
      headers: { cookie: 'vnc_ticket=good' },
    });
    expect(res.status).toBe(200);
  });

  it('403s an asset carrying a stale/invalid cookie', async () => {
    const res = await fetch(`${base}/vnc/core/rfb.js`, {
      headers: { cookie: 'vnc_ticket=stale' },
    });
    expect(res.status).toBe(403);
  });
});
