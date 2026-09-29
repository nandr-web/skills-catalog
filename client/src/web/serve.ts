// skills-catalog serve (contract §3; the web-local build notes, slice 3): the local web face's transport. It only moves
// bytes between Node's http server and web/handler.ts, where every rule is. Bound to 127.0.0.1 alone, port 0 by default;
// a --port that's taken exits 1 and never falls back. It prints one line, the page's address with its one-time pairing
// code, and nothing else ever holds the code or the session token: no file, log or later output.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Words } from '@skills-catalog/core';
import { API_HEADERS, BODY_LIMIT, SECURITY_HEADERS } from '@skills-catalog/core/http';
import type { Settings } from '../settings.ts';
import { createHandler, type WebRequest, type WebResponse } from './handler.ts';

/** `server`: for tests only (where it listens, its limits). */
export type Serving = { url: string; port: number; server: Server; close(): Promise<void> };
/** `handle`: for tests only, in place of the handler (the transport's own failure path). */
export type ServeOptions = { port: number; publish: boolean; settings: Settings; words: Words; pairingCode?: string; handle?: (req: WebRequest) => Promise<WebResponse> };

// A slow sender can't hold the server: its headers within 10 s, its whole request within 30 s, and at most 64 connections
// at once (one person's browser needs a handful).
const LIMITS = { headersTimeout: 10_000, requestTimeout: 30_000, maxConnections: 64 };

/** Each header as the handler reads it: one sent twice is no value, so it's refused like a missing one. Counted from the
 *  raw headers, since node:http keeps only the first of a repeated Host or Content-Type and joins most others. */
function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const seen = new Map<string, number>();
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const k = req.rawHeaders[i]!.toLowerCase();
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = seen.get(k) === 1 && typeof v === 'string' ? v : undefined;
  return headers;
}

/** The request as the handler reads it; `cut()` says whether the handler started reading its body and stopped short. */
function request(req: IncomingMessage): { web: WebRequest; cut(): boolean } {
  const headers = headersOf(req);
  // The path alone: a query is no part of any route.
  const path = (req.url ?? '/').split('?')[0]!;
  let read = false;
  // A handler that stops reading (a body cut at its limit) leaves the rest unread: stopping doesn't destroy the request
  // (a destroyed request can't be answered: the page would get a 500 for a too_large).
  const body = { [Symbol.asyncIterator]: () => ((read = true), req.iterator({ destroyOnReturn: false })) };
  return { web: { method: req.method ?? '', path, headers, body }, cut: () => read && !req.complete };
}

// A body cut at its limit: what's still being sent after the answer is read and thrown away (never held) for at most a
// second or twice the limit, whichever comes first, then the connection closed. Closing at once, with the sender still
// writing, would reset the connection, and a reset can lose the answer (no too_large, only ECONNRESET).
const LINGER = { ms: 1_000, bytes: 2 * BODY_LIMIT };

function lingerThenClose(req: IncomingMessage): void {
  let discarded = 0;
  const close = () => {
    clearTimeout(timer);
    req.off('data', count);
    req.socket.end();
    req.socket.destroy();
  };
  const count = (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded >= LINGER.bytes) close();
  };
  const timer = setTimeout(close, LINGER.ms);
  timer.unref();
  req.on('data', count);
  req.resume();
}

/** Starts the server; resolves once it's listening, or rejects with EADDRINUSE (the caller exits 1). */
export async function serve(o: ServeOptions): Promise<Serving> {
  // 16 random bytes: the code lives in the printed line and the page's address bar until the page trades it once.
  const pairingCode = o.pairingCode ?? randomBytes(16).toString('base64url');
  let handler: ReturnType<typeof createHandler> | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const q = request(req);
      const r = await (o.handle ?? handler!.handle)(q.web);
      if (q.cut()) {
        // Answered first (node:http would reset a `connection: close` answer's socket at once), then closed by
        // lingerThenClose within a second.
        res.writeHead(r.status, r.headers);
        res.end(r.body, () => lingerThenClose(req));
        return;
      }
      // A body the handler never read (a refusal) is dropped with the connection, never drained: a sender can't make
      // this process read an endless body just by being refused. The answer says so, so no client sends its next
      // request on a connection that's about to close.
      const unread = !req.complete;
      res.writeHead(r.status, unread ? { ...r.headers, connection: 'close' } : r.headers);
      res.end(r.body, () => {
        if (unread) req.destroy();
      });
    } catch {
      // A bug here: a bare 500 with the fixed headers, never stored, and the connection closed.
      if (!res.headersSent) res.writeHead(500, { ...SECURITY_HEADERS, ...API_HEADERS, connection: 'close' });
      res.end(() => req.destroy());
    }
  });
  Object.assign(server, LIMITS);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: o.port, exclusive: true }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as { port: number }).port;
  handler = createHandler({ port, pairingCode, publish: o.publish, settings: o.settings, words: o.words });
  return {
    url: `http://127.0.0.1:${port}/#p=${pairingCode}`,
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        handler?.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
