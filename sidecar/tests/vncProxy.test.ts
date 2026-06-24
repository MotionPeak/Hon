import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import Fastify from 'fastify';
import { registerVncProxy } from '../src/vncProxy.js';

let upstream: Server | undefined;
afterEach(() => upstream?.close());

function stubUpstream(port: number): Promise<void> {
  return new Promise((resolve) => {
    upstream = createServer((_req, res) => { res.writeHead(200); res.end('NOVNC-OK'); });
    upstream.listen(port, '127.0.0.1', () => resolve());
  });
}

describe('vnc HTTP proxy', () => {
  it('403s an invalid ticket and forwards a valid one to the upstream', async () => {
    await stubUpstream(6099);
    const app = Fastify();
    registerVncProxy(app, { upstreamPort: 6099, validateTicket: (t) => t === 'good' });
    await app.ready();

    const bad = await app.inject({ method: 'GET', url: '/vnc/vnc_lite.html?ticket=bad' });
    expect(bad.statusCode).toBe(403);

    const ok = await app.inject({ method: 'GET', url: '/vnc/vnc_lite.html?ticket=good' });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toContain('NOVNC-OK');
    await app.close();
  });
});
