// The local web face (contract §1.1, §3 `serve`, §7; the web-local build notes, slice 3), without a transport: web/serve.ts
// only moves bytes. The web API's shared half is the core's (@skills-catalog/core/http: the routes, the refusals' numbers,
// the envelope, a file's answer); this is the local transport's own: its guards, run before anything is looked up and
// before any of the body is read (Host exactly 127.0.0.1:<port>, then POST only on an operation, JSON only, Origin exactly
// this page's and the session token), reading the body cut at its limit, who is acting (setup's developers), pairing, and
// publishing only under --publish.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CatalogError, checkActor, openCatalog, randomIds, toCatalogError, type Catalog, type Words } from '@skills-catalog/core';
import { API_HEADERS, BODY_LIMIT, NOT_FOUND, SECURITY_HEADERS, envelope, fileResponse, operationResponse, refuse, route, type HttpResponse } from '@skills-catalog/core/http';
import { readConfig } from '../machine/lock.ts';
import { perform, type Context } from '../operations.ts';
import type { Settings } from '../settings.ts';

export type WebRequest = { method: string; path: string; headers: Record<string, string | undefined>; body: AsyncIterable<Uint8Array> };
export type WebResponse = HttpResponse;

/** The fixed parts, from the core: the headers on every response, those on /api, the 404's text, and the largest body read. */
export const POLICY = { headers: SECURITY_HEADERS, api: API_HEADERS, notFound: NOT_FOUND, bodyLimit: BODY_LIMIT };

const PAIR_LIMIT = 4096;   // {"code": "..."}
const JSON_TYPE = /^application\/json(\s*;\s*charset=utf-8)?$/i;

export type HandlerOptions = { port: number; pairingCode: string; publish: boolean; settings: Settings; words: Words; now?: () => Date };

export function createHandler(o: HandlerOptions): { handle(req: WebRequest): Promise<WebResponse>; close(): void } {
  const host = `127.0.0.1:${o.port}`;
  const origin = `http://${host}`;
  const now = o.now ?? (() => new Date());
  const words = o.words;
  // A local catalog has no sign-in: no developer is a setup matter, in its own words (as on every face).
  const sentences = { words, unauthenticated: words.word('errors.unauthenticated_local') as string };
  // The token exists only once the code was traded, and lives only in this process.
  let token: string | undefined;

  // Every read shares one read-only open (it never creates a catalog, sweeps or rebuilds an index); a real publish, only
  // under --publish, opens the catalog for writing as the developer acting on that request.
  const named = o.settings.catalog !== pathToFileURL(join(o.settings.home, 'catalog')).href;
  let reading: Promise<Catalog> | undefined;
  const readCatalog = () => (reading ??= openCatalog(o.settings.catalog, { readOnly: true, named }).catch((e) => ((reading = undefined), Promise.reject(e))));

  // A secret compared in constant time, whatever the lengths: a hash of each, then timingSafeEqual.
  const same = (given: string | undefined, expected: string | undefined) => {
    if (given === undefined || expected === undefined) return false;
    return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
  };

  /** Reads the body up to `limit` bytes; one byte past that it stops reading and says so, never holding more. */
  async function readBody(body: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array | 'cut'> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) return 'cut';
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** The developer acting on this request (contract §7): a name setup knows, `me` or one of `demo_developers`. */
  function actor(as: string | undefined): string {
    // Until setup's own config lands (P1b), config.json's `me` and `demo_developers` are read here.
    const config = readConfig(o.settings.home) as { me?: unknown; demo_developers?: unknown };
    const known = [config.me, ...(Array.isArray(config.demo_developers) ? config.demo_developers : [])].filter((d): d is string => typeof d === 'string');
    if (as === undefined) throw new CatalogError('unauthenticated', {});
    const name = checkActor(as, 'X-Skills-Catalog-As');
    if (!known.includes(name)) throw new CatalogError('unauthenticated', {});
    return name;
  }

  async function operation(op: string, req: WebRequest): Promise<WebResponse> {
    let developer: string;
    try {
      developer = actor(req.headers['x-skills-catalog-as']);
    } catch (e) {
      return envelope({ error: toCatalogError(e, o.settings.home, now()) }, sentences);
    }
    const raw = await readBody(req.body, BODY_LIMIT);
    let writing: Promise<Catalog> | undefined;
    // Through perform, so the web's calls are in the activity log and the usage metrics like every face's.
    const run = async (name: string, input: Record<string, unknown>) => {
      const real = name === 'publish_version' && input['dry_run'] !== true;
      if (real && !o.publish) throw new CatalogError('forbidden', { why: 'read_only' });
      const ctx: Context = {
        catalog: real ? () => (writing ??= openCatalog(o.settings.catalog)) : readCatalog,
        words,
        settings: { ...o.settings, developer, developerInvalid: false },
        face: 'web',
        now,
        ids: randomIds,
      };
      const a = await perform(ctx, name, name, input);
      if (a.isError) throw a.error!;
      return a.data;
    };
    try {
      return await operationResponse({ op, raw, developer, run, where: 'local', ...sentences });
    } catch (e) {
      return envelope({ error: toCatalogError(e, o.settings.home, now()) }, sentences);
    } finally {
      void writing?.then((c) => c.close()).catch(() => {});
    }
  }

  async function pair(req: WebRequest): Promise<WebResponse> {
    const raw = await readBody(req.body, PAIR_LIMIT);
    if (token !== undefined || raw === 'cut') return refuse('no_token', sentences);
    let code: unknown;
    try {
      code = (JSON.parse(new TextDecoder().decode(raw)) as { code?: unknown }).code;
    } catch {
      return refuse('no_token', sentences);
    }
    if (typeof code !== 'string' || !same(code, o.pairingCode)) return refuse('no_token', sentences);
    token = randomBytes(32).toString('base64url');
    return envelope({ data: { token } }, sentences);
  }

  async function file(req: WebRequest, sha256: string): Promise<WebResponse> {
    // A GET from the page itself may carry no Origin (browsers leave it off a same-origin GET): a present one must match,
    // and so must Sec-Fetch-Site when sent. The token is always needed.
    if (req.headers['origin'] !== undefined && req.headers['origin'] !== origin) return refuse('refused', sentences);
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return refuse('refused', sentences);
    if (!same(req.headers['x-skills-catalog-token'], token)) return refuse('no_token', sentences);
    // Opened only for a well-formed fingerprint (the core checks it first).
    return fileResponse({ file: async (sha) => (await readCatalog()).file(sha) }, sha256);
  }

  async function handle(req: WebRequest): Promise<WebResponse> {
    if (req.headers['host'] !== host) return refuse('refused', sentences);
    const r = route(req.method, req.path, 'local');
    if (r.kind === 'not_found' && !r.operationPath) return refuse('not_found', sentences);
    if (r.kind === 'file') return file(req, r.sha256);
    if (r.kind === 'method') return refuse('method', { ...sentences, allow: r.allow });
    if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return refuse('not_json', sentences);
    if (req.headers['origin'] !== origin) return refuse('refused', sentences);
    if (r.kind === 'pair') return pair(req);
    if (!same(req.headers['x-skills-catalog-token'], token)) return refuse('no_token', sentences);
    // An operation no one serves on the web is the fixed 404 only now, past the token: an unpaired caller learns nothing.
    if (r.kind === 'not_found') return refuse('not_found', sentences);
    return operation(r.op, req);
  }

  return { handle, close: () => void reading?.then((c) => c.close()).catch(() => {}) };
}
