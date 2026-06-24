import { request as httpRequest, type Server, type IncomingMessage } from 'node:http';
import { connect as netConnect, type Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { makeLog } from './log.js';

const vlog = makeLog('vnc:proxy');

interface VncProxyOpts {
  /** Local websockify port (serves the noVNC client + the WS bridge). */
  upstreamPort: number;
  /** Validates the one-time ticket carried in the `?ticket=` query. */
  validateTicket: (ticket: string) => boolean;
}

function ticketOf(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return '';
  return new URLSearchParams(url.slice(q + 1)).get('ticket') ?? '';
}

/** HTTP half: proxy GET /vnc/* → 127.0.0.1:<upstreamPort>/* when the ticket is
 *  valid. The noVNC static client (vnc_lite.html, JS, CSS) is served by
 *  websockify's --web, so this just streams it through. */
export function registerVncProxy(app: FastifyInstance, opts: VncProxyOpts): void {
  app.get('/vnc', (_req, reply) => reply.redirect('/vnc/vnc_lite.html'));
  app.all('/vnc/*', (req, reply) => {
    if (!opts.validateTicket(ticketOf(req.url))) {
      reply.code(403).send({ error: 'invalid or expired sign-in ticket' });
      return;
    }
    // Strip the /vnc prefix; websockify serves its client at the root.
    const upstreamPath = req.url.replace(/^\/vnc/, '') || '/';
    const proxyReq = httpRequest(
      {
        host: '127.0.0.1',
        port: opts.upstreamPort,
        method: req.method,
        path: upstreamPath,
        headers: req.headers,
      },
      (proxyRes) => {
        reply.raw.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(reply.raw);
      },
    );
    proxyReq.on('error', (e) => {
      vlog.warn('http proxy error', { message: e.message });
      if (!reply.sent) reply.code(502).send({ error: 'vnc upstream unavailable' });
    });
    req.raw.pipe(proxyReq);
  });
}

/** WebSocket half: attach to the shared http.Server's 'upgrade' event. noVNC
 *  opens wss://<host>/vnc/websockify?ticket=… ; validate the ticket, then raw-
 *  pipe the TCP streams to websockify. Returns a detach function for tests. */
export function attachVncUpgrade(server: Server, opts: VncProxyOpts): () => void {
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const url = req.url ?? '';
    if (!url.startsWith('/vnc/')) return; // not ours — leave for other handlers
    if (!opts.validateTicket(ticketOf(url))) { socket.destroy(); return; }
    const upstreamPath = url.replace(/^\/vnc/, '') || '/';
    const upstream = netConnect(opts.upstreamPort, '127.0.0.1', () => {
      const headerLines = [
        `${req.method} ${upstreamPath} HTTP/1.1`,
        ...Object.entries(req.headers).map(
          ([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`,
        ),
        '', '',
      ].join('\r\n');
      upstream.write(headerLines);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  };
  server.on('upgrade', onUpgrade);
  return () => server.off('upgrade', onUpgrade);
}
