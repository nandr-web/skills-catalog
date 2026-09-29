// The web API's transport-free half (contract §1.1), shared by the local `serve` and the hosted handler: the routes, the
// numbers of the guards' refusals, a body's parse as the web face, the per-method call into the Catalog, the envelope with
// its words, and the files route's answer. Each transport keeps its own reading of the stream (cut at its limit), every
// guard (run before anything here and before the body is read), and who is acting. Nothing here touches a disk, a socket
// or the process (test/http-deps.test.ts).
import { OPERATIONS, validateInput, webRow, type Face, type OperationDef, type Where } from '../api.ts';
import type { Catalog, FileAnswer } from '../catalog.ts';
import { CatalogError, isCatalogError } from '../errors.ts';
import type { Identity } from '../ports.ts';
import { renderError } from '../render.ts';
import { DEFAULT_LIMITS } from '../skill-tree/index.ts';
import type { Words } from '../words-file.ts';

export type { FileAnswer };
export type HttpResponse = { status: number; headers: Record<string, string>; body: string | Uint8Array };

/** A guard's refusal, by kind, and the files route's non-200 answers: one table, so every transport uses the same numbers.
 *  Operation results, errors included, are never here: they are 200 in the envelope. */
export const STATUS = { no_token: 401, refused: 403, not_found: 404, method: 405, not_json: 415, token_only: 400, link: 302, on_its_way: 503 } as const;
export type Refusal = 'no_token' | 'refused' | 'not_found' | 'method' | 'not_json' | 'token_only';

/** On every response; `API_HEADERS` on /api besides. Never any Access-Control-*. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
export const API_HEADERS: Readonly<Record<string, string>> = { 'cache-control': 'no-store' };
export const NOT_FOUND = 'Not found.\n';
const JSON_HEADERS = { ...API_HEADERS, 'content-type': 'application/json; charset=utf-8' };

/** The largest request body a transport reads: a skill at the core's limit, as base64, plus room for 100 paths and the
 *  message. A publish over the core's limits still reaches the core, which says too_large in its own words; a body past
 *  this is cut while it's read. */
export const BODY_LIMIT = Math.ceil(DEFAULT_LIMITS.skill_bytes / 3) * 4 + 100 * 4096 + 64 * 1024;

const SHA256 = /^[0-9a-f]{64}$/;
const API = '/api/v1/';
const FILES = /^\/api\/v1\/files\/([^/]*)$/;

export type Route =
  | { kind: 'operation'; op: string }
  | { kind: 'file'; sha256: string }
  | { kind: 'pair' }
  /** `allow`: the one method the path takes (the 405's Allow header). */
  | { kind: 'method'; allow: 'GET' | 'POST' }
  /** `operationPath`: under /api/v1/ with no such web operation. A transport refuses it after its token check, so an
   *  unknown caller learns nothing of what exists. */
  | { kind: 'not_found'; operationPath: boolean };

/** Where a request goes, from its method and path alone: nothing is looked up. An operation is routed exactly when the
 *  API's one rule (webRow, the same one the published schemas use) serves it on the web face of this kind of catalog. */
export function route(method: string, path: string, where: Where): Route {
  if (path === '/api/pair') return method === 'POST' ? { kind: 'pair' } : { kind: 'method', allow: 'POST' };
  if (!path.startsWith(API)) return { kind: 'not_found', operationPath: false };
  const file = FILES.exec(path);
  if (file) return method === 'GET' ? { kind: 'file', sha256: file[1]! } : { kind: 'method', allow: 'GET' };
  if (method !== 'POST') return { kind: 'method', allow: 'POST' };
  const op = path.slice(API.length);
  return webRow(op, where) ? { kind: 'operation', op } : { kind: 'not_found', operationPath: true };
}

/** What an operation does (its row's effect), so a caller whose token may only read is refused a write before dispatch. */
export function effectOf(op: string, where: Where): OperationDef['effect'] | undefined {
  return webRow(op, where) ? OPERATIONS[op]!.effect : undefined;
}

/** A body the transport read (or cut at its limit) as an operation's input, checked as the web face of a catalog `where`
 *  it is: a person-only input (cliOnly) is an unknown field here, and so is the other kind of catalog's own input. */
export function parseBody(op: string, raw: Uint8Array | 'cut', where: Where, max = BODY_LIMIT): Record<string, unknown> {
  // Size limits stay in the core, never only at the edge: a body its transport didn't cut is measured here too.
  if (raw === 'cut' || raw.byteLength > max) throw new CatalogError('too_large', { limit: 'request_bytes', max });
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new CatalogError('invalid_request', { field: 'body', why: 'not_json' });
  }
  return validateInput<Record<string, unknown>>(op, parsed, 'web', where);
}

type CatalogMethod = (input: unknown, face: Face) => Promise<unknown>;

/** One operation on the Catalog, through the method its row names, with the caller's face in its own slot: a method
 *  that acts as someone (its row's `acts`) takes the identity second (the developer acting on this call, so one shared
 *  catalog serves every caller), then the face; every other method's second is the face. */
export async function dispatch(op: string, input: unknown, o: { catalog: Catalog; developer: string | undefined; face: Face }): Promise<unknown> {
  const row = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op]! : undefined;
  const method = row ? (o.catalog as unknown as Record<string, unknown>)[row.run] : undefined;
  if (!row || typeof method !== 'function') throw new Error(`no Catalog method for ${op}`);
  if (row.acts) {
    const identity: Identity = { actor: async () => o.developer };
    return (method as (input: unknown, identity: Identity, face: Face) => Promise<unknown>).call(o.catalog, input, identity, o.face);
  }
  return (method as CatalogMethod).call(o.catalog, input, o.face);
}

type Sentences = {
  words: Words;
  /** A transport's own sentence for unauthenticated (a local catalog has no sign-in); every other one is the words file's. */
  unauthenticated?: string;
};

function sentence(s: Sentences, err: CatalogError): string {
  return err.code === 'unauthenticated' && s.unauthenticated !== undefined ? s.unauthenticated : renderError(s.words, err);
}

/** The envelope, 200 whatever the answer: {ok: true, data, words?} or {ok: false, error: {code, ...data}, words?}. */
export function envelope(answer: { data: unknown; developer?: string } | { error: CatalogError }, s: Sentences): HttpResponse {
  const body =
    'error' in answer
      ? { ok: false, error: answer.error.toJSON(), words: { error: sentence(s, answer.error) } }
      : { ok: true, data: answer.data, ...(answer.developer ? { words: { acting_as: s.words.format(s.words.word('acting_as'), { developer: answer.developer }) } } : {}) };
  return { status: 200, headers: { ...SECURITY_HEADERS, ...JSON_HEADERS }, body: JSON.stringify(body) };
}

/** An operation's whole answer once the transport's guards have passed and it has read the body: parse as the web face,
 *  run (the transport's own `run`, e.g. one that logs, or `dispatch`), and the envelope. A CatalogError is the envelope's
 *  error; anything else is a bug the transport turns into internal_error its own way. */
export async function operationResponse(
  o: Sentences & { op: string; raw: Uint8Array | 'cut'; developer: string | undefined; max?: number } & (
      | { run: (op: string, input: Record<string, unknown>) => Promise<unknown>; where: Where }
      | { catalog: Catalog }
    ),
): Promise<HttpResponse> {
  try {
    const input = parseBody(o.op, o.raw, 'run' in o ? o.where : o.catalog.where, o.max);
    const data = await ('run' in o ? o.run(o.op, input) : dispatch(o.op, input, { catalog: o.catalog, developer: o.developer, face: 'web' }));
    return envelope({ data, developer: o.developer }, o);
  } catch (e) {
    if (isCatalogError(e)) return envelope({ error: e }, o);
    throw e;
  }
}

/** A guard's refusal: its number from the one table, the fixed 404's text, and for token_only the error in the envelope.
 *  `challenge`, for a catalog with sign-in (hosted): a 401 is the envelope's unauthenticated with WWW-Authenticate naming
 *  the scheme; a local 401 (the page's session token) stays bare, since there's no sign-in to point to. */
export function refuse(kind: Refusal, s: Sentences & { challenge?: 'Bearer'; allow?: 'GET' | 'POST' }): HttpResponse {
  const status = STATUS[kind];
  if (kind === 'not_found') return notFound();
  if (kind === 'method') return { status, headers: { ...SECURITY_HEADERS, ...API_HEADERS, ...(s.allow ? { allow: s.allow } : {}) }, body: '' };
  if (kind === 'token_only') return { ...envelope({ error: new CatalogError('invalid_request', { field: 'X-Skills-Catalog-As', why: 'token_only' }) }, s), status };
  if (kind === 'no_token' && s.challenge) {
    const e = envelope({ error: new CatalogError('unauthenticated', {}) }, s);
    return { ...e, status, headers: { ...e.headers, 'www-authenticate': s.challenge } };
  }
  return { status, headers: { ...SECURITY_HEADERS, ...API_HEADERS }, body: '' };
}

/** GET /api/v1/files/<sha256> once the guards have passed: a malformed fingerprint is never looked up. */
export async function fileResponse(catalog: { file(sha256: string): Promise<FileAnswer> }, sha256: string): Promise<HttpResponse> {
  const answer: FileAnswer = SHA256.test(sha256) ? await catalog.file(sha256) : { kind: 'unknown' };
  const api = { ...SECURITY_HEADERS, ...API_HEADERS };
  switch (answer.kind) {
    case 'bytes':
      // A download, never a page: even opened directly, it runs nothing (the policy's sandbox).
      return {
        status: 200,
        headers: { ...api, 'content-type': 'application/octet-stream', 'content-disposition': 'attachment', 'content-security-policy': `${SECURITY_HEADERS['content-security-policy']}; sandbox` },
        body: answer.bytes,
      };
    case 'link':
      return { status: STATUS.link, headers: { ...api, location: answer.url }, body: '' };
    case 'on_its_way':
      return { status: STATUS.on_its_way, headers: { ...api, 'retry-after': '2' }, body: '' };
    default:
      return notFound();
  }
}

/** The fixed 404: never stored by a cache on the way (a CDN in front of a hosted catalog), like every answer on /api. */
function notFound(): HttpResponse {
  return { status: STATUS.not_found, headers: { ...SECURITY_HEADERS, ...API_HEADERS, 'content-type': 'text/plain; charset=utf-8' }, body: NOT_FOUND };
}
