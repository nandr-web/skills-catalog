// The hosted API's handler (contract §1.1), without a transport: the Lambda adapter only turns its event into a request
// (body read whole, or 'cut' past the limit) and the answer back. The shared half comes from the core (routes, the
// envelope, the status table, the files route); hosted adds who's asking: the Bearer token, checked before anything
// under /api/v1/ is looked up or read, so a caller without a good token learns nothing of what exists; the acting-as
// header refused; a read-scope token refused whatever changes the catalog, before it runs. No pairing route.

import { CatalogError, type Catalog, type Words } from '@skills-catalog/core';
import { STATUS, envelope, fileResponse, operationResponse, refuse, route, type FileAnswer, type HttpResponse } from '@skills-catalog/core/http';
import type { TokenHolder } from '../tokens.ts';
import { mayRun, whoIsAsking } from './who.ts';

export type HostedRequest = { method: string; path: string; headers: Record<string, string | undefined>; body: Uint8Array | 'cut' };

export type HostedHandlerParts = {
  catalog: Catalog;
  tokens: { verify(token: string): Promise<TokenHolder | undefined> };
  words: Words;
  /** A file by its fingerprint: a link when a version names it, on its way, or unknown. */
  file(sha256: string): Promise<FileAnswer>;
  /** Where a bug's details go (the function's log): never skill text or a token. */
  log?: (line: string) => void;
};

export function createHostedHandler(p: HostedHandlerParts): { handle(req: HostedRequest): Promise<HttpResponse> } {
  const s = { words: p.words };
  const log = p.log ?? ((line: string) => console.error(line));

  async function answer(req: HostedRequest): Promise<HttpResponse> {
    const r = route(req.method, req.path);
    // Outside the versioned API (the page, pairing) nothing is served here.
    if (r.kind === 'pair' || (r.kind === 'not_found' && !r.operationPath)) return refuse('not_found', s);

    const asking = await whoIsAsking(req.headers, p.tokens);
    if (asking.kind === 'refused') {
      if (asking.status === STATUS.token_only) return refuse('token_only', s);
      const e = envelope({ error: asking.error }, s);
      return { ...e, status: STATUS.no_token, headers: { ...e.headers, ...asking.headers } };
    }

    if (r.kind === 'file') return fileResponse({ file: p.file }, r.sha256);
    if (r.kind === 'method') return refuse('method', s);
    if (r.kind === 'not_found') return refuse('not_found', s);

    const refused = mayRun(asking.holder, r.op);
    if (refused) return envelope({ error: refused }, s);
    return operationResponse({ ...s, op: r.op, raw: req.body, catalog: p.catalog, developer: asking.holder.owner, face: 'web' });
  }

  return {
    async handle(req) {
      try {
        return await answer(req);
      } catch (e) {
        // A bug: its details go to the function's log by name and stack only; the caller gets internal_error.
        log(`internal_error: ${e instanceof Error ? `${e.name}: ${e.stack ?? e.message}` : typeof e}`);
        return envelope({ error: new CatalogError('internal_error', {}) }, s);
      }
    },
  };
}
