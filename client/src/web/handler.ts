// The local web face (contract §1.1, §3 `serve`, §7; the web-local build notes, slice 3), without a transport: web/serve.ts
// only moves bytes, and every rule is here. A request is refused by its guards before anything is looked up and before
// any of its body is read: Host exactly 127.0.0.1:<port> (403), then on /api POST only (405), JSON only (415), Origin
// exactly this page's (403) and the session token (401). The routes are the operations whose row serves the web face, as
// own keys (anything else is the fixed 404); an operation's result, error or not, is 200 in the envelope
// {ok: true, data, words?} or {ok: false, error: {code, ...its data}, words?}. Pairing, outside the versioned API, trades
// the printed code once for the session token. A version's files are served by fingerprint behind the same guards.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CatalogError, OPERATIONS, actAs, checkActor, openCatalog, randomIds, renderError, toCatalogError, validateInput, type Catalog, type Words } from '@skills-catalog/core';
import { DEFAULT_LIMITS } from '@skills-catalog/core/skill-tree';
import { readConfig } from '../machine/lock.ts';
import { actingAs, perform, type Context } from '../operations.ts';
import type { Settings } from '../settings.ts';

export type WebRequest = { method: string; path: string; headers: Record<string, string | undefined>; body: AsyncIterable<Buffer> };
export type WebResponse = { status: number; headers: Record<string, string>; body: string | Buffer };

/** The fixed parts: the headers on every response, those on /api, the 404's text, and the largest body read. */
export const POLICY = {
  headers: {
    'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
  } as Record<string, string>,
  api: { 'cache-control': 'no-store' } as Record<string, string>,
  notFound: 'Not found.\n',
  // A skill at the core's limit, as base64, plus room for 100 paths and the message: a publish over the core's limits
  // still reaches the core, which says too_large in its own words; anything past this is cut while it's read.
  bodyLimit: Math.ceil(DEFAULT_LIMITS.skill_bytes / 3) * 4 + 100 * 4096 + 64 * 1024,
};

const PAIR_LIMIT = 4096;   // {"code": "..."}
const SHA256 = /^[0-9a-f]{64}$/;
const JSON_TYPE = /^application\/json(\s*;\s*charset=utf-8)?$/i;

export type HandlerOptions = { port: number; pairingCode: string; publish: boolean; settings: Settings; words: Words; now?: () => Date };

export function createHandler(o: HandlerOptions): { handle(req: WebRequest): Promise<WebResponse>; close(): void } {
  const host = `127.0.0.1:${o.port}`;
  const origin = `http://${host}`;
  const now = o.now ?? (() => new Date());
  const words = o.words;
  // The token exists only once the code was traded, and lives only in this process.
  let token: string | undefined;

  // Every read shares one read-only open (it never creates a catalog, sweeps or rebuilds an index); a real publish, only
  // under --publish, opens the catalog for writing as the developer acting on that request.
  const named = o.settings.catalog !== pathToFileURL(join(o.settings.home, 'catalog')).href;
  let reading: Promise<Catalog> | undefined;
  const readCatalog = () => (reading ??= openCatalog(o.settings.catalog, { readOnly: true, named }).catch((e) => ((reading = undefined), Promise.reject(e))));

  const respond = (status: number, body: string | Buffer, extra: Record<string, string> = {}): WebResponse => ({ status, headers: { ...POLICY.headers, ...extra }, body });
  const notFound = () => respond(404, POLICY.notFound, { 'content-type': 'text/plain; charset=utf-8' });
  const envelope = (body: unknown) => respond(200, JSON.stringify(body), { ...POLICY.api, 'content-type': 'application/json; charset=utf-8' });
  const refusal = (status: number) => respond(status, '', POLICY.api);
  const failed = (err: CatalogError) => envelope({ ok: false, error: err.toJSON(), words: { error: sentence(err) } });
  // A local catalog has no sign-in: no developer is a setup matter, in its own words (as on every face).
  const sentence = (err: CatalogError) => (err.code === 'unauthenticated' ? words.word('errors.unauthenticated_local') : renderError(words, err));

  // A secret compared in constant time, whatever the lengths: a hash of each, then timingSafeEqual.
  const same = (given: string | undefined, expected: string | undefined) => {
    if (given === undefined || expected === undefined) return false;
    return timingSafeEqual(createHash('sha256').update(given).digest(), createHash('sha256').update(expected).digest());
  };

  /** Reads the body up to `limit` bytes; past that it stops reading and says so, never holding more. */
  async function readBody(body: AsyncIterable<Buffer>, limit: number): Promise<Buffer | 'too_large'> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      size += chunk.length;
      if (size > limit) return 'too_large';
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
    let input: Record<string, unknown>;
    try {
      developer = actor(req.headers['x-skills-catalog-as']);
      const raw = await readBody(req.body, POLICY.bodyLimit);
      if (raw === 'too_large') throw new CatalogError('too_large', { limit: 'request_bytes', max: POLICY.bodyLimit });
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new CatalogError('invalid_request', { field: 'body', why: 'not_json' });
      }
      // The web face's schema: a person-only input (cliOnly) is an unknown field here.
      input = validateInput<Record<string, unknown>>(op as keyof typeof OPERATIONS, parsed, 'web');
    } catch (e) {
      return failed(toCatalogError(e, o.settings.home, now()));
    }
    const real = op === 'publish_version' && input['dry_run'] !== true;
    if (real && !o.publish) return failed(new CatalogError('forbidden', { why: 'read_only' }));
    let writing: Promise<Catalog> | undefined;
    const settings: Settings = { ...o.settings, developer, developerInvalid: false };
    const ctx: Context = {
      catalog: real ? () => (writing ??= openCatalog(o.settings.catalog, { identity: actAs(developer) })) : readCatalog,
      words,
      settings,
      face: 'web',
      now,
      ids: randomIds,
    };
    try {
      const a = await perform(ctx, op, op, input);
      if (a.isError) return failed(a.error!);
      return envelope({ ok: true, data: a.data, words: { acting_as: actingAs(words, developer) } });
    } finally {
      void writing?.then((c) => c.close()).catch(() => {});
    }
  }

  async function pair(req: WebRequest): Promise<WebResponse> {
    const raw = await readBody(req.body, PAIR_LIMIT);
    if (token !== undefined || raw === 'too_large') return refusal(401);
    let code: unknown;
    try {
      code = (JSON.parse(raw.toString('utf8')) as { code?: unknown }).code;
    } catch {
      return refusal(401);
    }
    if (typeof code !== 'string' || !same(code, o.pairingCode)) return refusal(401);
    token = randomBytes(32).toString('base64url');
    return envelope({ ok: true, data: { token } });
  }

  async function file(req: WebRequest, sha: string): Promise<WebResponse> {
    // A GET from the page itself may carry no Origin (browsers leave it off a same-origin GET): a present one must match,
    // and so must Sec-Fetch-Site when sent. The token is always needed.
    if (req.headers['origin'] !== undefined && req.headers['origin'] !== origin) return refusal(403);
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return refusal(403);
    if (!same(req.headers['x-skills-catalog-token'], token)) return refusal(401);
    if (!SHA256.test(sha)) return notFound();
    const catalog = (await readCatalog()) as Catalog & { file(sha256: string): Promise<Uint8Array | undefined> };
    const bytes = await catalog.file(sha);
    if (!bytes) return notFound();
    return respond(200, Buffer.from(bytes), { ...POLICY.api, 'content-type': 'application/octet-stream' });
  }

  async function handle(req: WebRequest): Promise<WebResponse> {
    if (req.headers['host'] !== host) return refusal(403);
    const path = req.path;
    if (path !== '/api/pair' && !path.startsWith('/api/v1/')) return notFound();
    const files = /^\/api\/v1\/files\/([^/]*)$/.exec(path);
    if (files && req.method === 'GET') return file(req, files[1]!);
    if (req.method !== 'POST') return refusal(405);
    if (!JSON_TYPE.test(req.headers['content-type'] ?? '')) return refusal(415);
    if (req.headers['origin'] !== origin) return refusal(403);
    if (path === '/api/pair') return pair(req);
    if (!same(req.headers['x-skills-catalog-token'], token)) return refusal(401);
    const op = path.slice('/api/v1/'.length);
    const row = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : undefined;
    if (!row || !row.faces.includes('web')) return notFound();
    return operation(op, req);
  }

  return { handle, close: () => void reading?.then((c) => c.close()).catch(() => {}) };
}
