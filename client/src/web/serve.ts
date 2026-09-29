// skills-catalog serve (contract §3; the web-local build notes, slice 3): the local web face's transport. It only moves
// bytes between Node's http server and web/handler.ts, where every rule is. Bound to 127.0.0.1 alone, port 0 by default;
// a --port that's taken exits 1 and never falls back. It prints one line, the page's address with its one-time pairing
// code, and nothing else ever holds the code or the session token: no file, log or later output.
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Words } from '@skills-catalog/core';
import type { Settings } from '../settings.ts';
import { createHandler, type WebRequest } from './handler.ts';

export type Serving = { url: string; port: number; close(): Promise<void> };
export type ServeOptions = { port: number; publish: boolean; settings: Settings; words: Words; pairingCode?: string };

/** One header's value as the handler reads it: a repeated header is no value (it can't be exactly this server's own). */
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

function request(req: IncomingMessage): WebRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k] = one(v);
  // The path alone: a query is no part of any route.
  const path = (req.url ?? '/').split('?')[0]!;
  return { method: req.method ?? '', path, headers, body: req };
}

/** Starts the server; resolves once it's listening, or rejects with EADDRINUSE (the caller exits 1). */
export async function serve(o: ServeOptions): Promise<Serving> {
  // 16 random bytes: the code lives in the printed line and the page's address bar until the page trades it once.
  const pairingCode = o.pairingCode ?? randomBytes(16).toString('base64url');
  let handler: ReturnType<typeof createHandler> | undefined;
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const r = await handler!.handle(request(req));
      // A body the handler never read (a refusal) is dropped with the connection, never drained: a sender can't make
      // this process read an endless body just by being refused. The answer says so, so no client sends its next
      // request on a connection that's about to close.
      const unread = !req.complete;
      res.writeHead(r.status, unread ? { ...r.headers, connection: 'close' } : r.headers);
      res.end(r.body, () => {
        if (unread) req.destroy();
      });
    } catch {
      if (!res.headersSent) res.writeHead(500, {});
      res.end();
      req.destroy();
    }
  });
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
    close: () =>
      new Promise<void>((resolve) => {
        handler?.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
