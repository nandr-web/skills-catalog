// The web API's shared cases (contract §1.1): what every transport answers once its own guards have passed, the local
// `serve` and the hosted handler alike. Each runner seeds `HTTP_SEED`, answers each case through its own transport and
// checks it with `checkHttpCase`. A file case gives the catalog's answer for that fingerprint (a fake is enough); a
// malformed fingerprint must never reach the catalog. A refusal case names a guard's kind: its status and body come from
// the core's one table, so no transport picks its own numbers.
import type { FileAnswer, HttpResponse, Refusal } from '../src/http/index.ts';

/** The skills every runner publishes first, as `dev1`, in this order. */
export const HTTP_SEED: readonly { name: string; description: string }[] = [
  { name: 'release-notes-kit', description: 'Draft release notes from merged pull requests.' },
  { name: 'sql-migration-helper', description: 'Write and review SQL schema migrations.' },
];
export const HTTP_DEVELOPER = 'dev1';
export const skillMd = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\nBody.\n`;
const b64 = (text: string) => Buffer.from(text).toString('base64');
const newSkill = { name: 'web-published', files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('web-published', 'Published from the web.')) }] };

export const SHA = 'a'.repeat(64);

export type HttpCase = {
  name: string;
  /** A request past the transport's guards: `body` 'cut' is one the transport stopped reading at its limit. */
  request?: { method: string; path: string; body?: string | 'cut' };
  /** For GET /api/v1/files/<sha256>: what the catalog answers for that fingerprint. */
  file?: FileAnswer;
  /** A guard's refusal, by kind. */
  refuse?: Refusal;
  expect: {
    status: number;
    /** A subset of the JSON body (objects matched key by key, arrays and values exactly). */
    json?: unknown;
    /** The keys of the envelope's `words`, exactly. */
    words?: string[];
    text?: string;
    headers?: Record<string, string>;
    bytes?: string;
  };
};

const post = (op: string, body: unknown) => ({ method: 'POST', path: `/api/v1/${op}`, body: typeof body === 'string' ? body : JSON.stringify(body) });
const file = (sha = SHA) => ({ method: 'GET', path: `/api/v1/files/${sha}` });
export const NOT_FOUND_TEXT = 'Not found.\n';

export const httpCases: readonly HttpCase[] = [
  // Operations: a result, error or not, is 200 in the envelope.
  { name: 'a result is {ok: true, data, words: {acting_as}}', request: post('search_shared_skills', { query: 'release notes' }), expect: { status: 200, json: { ok: true, data: { total_matches: 1, results: [{ name: 'release-notes-kit' }] } }, words: ['acting_as'], headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } } },
  { name: 'an error is {ok: false, error: {code, ...data}, words: {error}}', request: post('list_shared_skill_versions', { name: 'no-such-skill' }), expect: { status: 200, json: { ok: false, error: { code: 'not_found' } }, words: ['error'] } },
  { name: 'a body that isn\'t JSON is invalid_request {field: body, why: not_json}', request: post('search_shared_skills', '{not json'), expect: { status: 200, json: { ok: false, error: { code: 'invalid_request', field: 'body', why: 'not_json' } }, words: ['error'] } },
  { name: 'a body cut at the limit is too_large {limit: request_bytes}, never a 413', request: { ...post('search_shared_skills', {}), body: 'cut' }, expect: { status: 200, json: { ok: false, error: { code: 'too_large', limit: 'request_bytes' } }, words: ['error'] } },
  { name: 'a person-only input is an unknown field on the web', request: post('publish_version', { ...newSkill, dry_run: true, allow_suspected_secrets: true }), expect: { status: 200, json: { ok: false, error: { code: 'invalid_request', field: 'allow_suspected_secrets', why: 'unknown_field' } } } },
  { name: 'a publish acts as the acting developer', request: post('publish_version', { ...newSkill, dry_run: true }), expect: { status: 200, json: { ok: true, data: { name: 'web-published', dry_run: true, publisher: HTTP_DEVELOPER } } } },
  // Routes: the operations whose faces include web, as own keys; anything else is the fixed 404.
  ...['nothing_here', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'install_shared_skill', 'publish_skill_to_catalog'].map(
    (op): HttpCase => ({ name: `no web operation ${op}: the fixed 404`, request: post(op, {}), expect: { status: 404, text: NOT_FOUND_TEXT } }),
  ),
  ...['/', '/index.html', '/api', '/api/search_shared_skills', '/api/v2/search_shared_skills'].map(
    (path): HttpCase => ({ name: `not an API path ${path}: the fixed 404`, request: { method: 'POST', path, body: '{}' }, expect: { status: 404, text: NOT_FOUND_TEXT } }),
  ),
  ...['GET', 'PUT', 'DELETE'].map((method): HttpCase => ({ name: `${method} on an operation: 405`, request: { method, path: '/api/v1/search_shared_skills' }, expect: { status: 405 } })),
  // Files by fingerprint: the catalog's answer, whatever the transport.
  { name: 'a stored file\'s bytes: 200', request: file(), file: { kind: 'bytes', bytes: new TextEncoder().encode('hello') }, expect: { status: 200, bytes: 'hello', headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' } } },
  { name: 'a link to a stored file: 302, no-store', request: file(), file: { kind: 'link', url: 'https://files.example/a?sig=1' }, expect: { status: 302, headers: { location: 'https://files.example/a?sig=1', 'cache-control': 'no-store' } } },
  { name: 'a file on its way: 503, Retry-After 2', request: file(), file: { kind: 'on_its_way' }, expect: { status: 503, headers: { 'retry-after': '2' } } },
  { name: 'a file no version names: the fixed 404', request: file(), file: { kind: 'unknown' }, expect: { status: 404, text: NOT_FOUND_TEXT } },
  ...[SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, 'z'.repeat(64), ''].map((bad): HttpCase => ({ name: `a malformed fingerprint "${bad.slice(0, 8)}…": 404, never looked up`, request: file(bad), expect: { status: 404, text: NOT_FOUND_TEXT } })),
  { name: 'POST on a file: 405', request: { method: 'POST', path: `/api/v1/files/${SHA}`, body: '{}' }, expect: { status: 405 } },
  // The guards' refusals: one table of numbers.
  { name: 'no token or a wrong one: 401', refuse: 'no_token', expect: { status: 401 } },
  { name: 'a Host, Origin or Sec-Fetch-Site not its own: 403', refuse: 'refused', expect: { status: 403 } },
  { name: 'a body that isn\'t JSON by its Content-Type: 415', refuse: 'not_json', expect: { status: 415 } },
  { name: 'the local act-as header on a hosted catalog: 400 invalid_request {field: X-Skills-Catalog-As, why: token_only}', refuse: 'token_only', expect: { status: 400, json: { ok: false, error: { code: 'invalid_request', field: 'X-Skills-Catalog-As', why: 'token_only' } } } },
];

/** Whether `actual` holds everything `expected` names (objects key by key, arrays element by element, values exactly). */
function holds(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.every((e, i) => holds(actual[i], e));
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') return false;
    return Object.entries(expected).every(([k, v]) => Object.hasOwn(actual, k) && holds((actual as Record<string, unknown>)[k], v));
  }
  return Object.is(actual, expected);
}

/** What's wrong with a response to a case ([] when nothing is). */
export function checkHttpCase(c: HttpCase, r: HttpResponse): string[] {
  const wrong: string[] = [];
  const text = typeof r.body === 'string' ? r.body : new TextDecoder().decode(r.body);
  if (r.status !== c.expect.status) wrong.push(`status ${r.status}, expected ${c.expect.status}`);
  for (const [k, v] of Object.entries(c.expect.headers ?? {})) if (r.headers[k] !== v) wrong.push(`header ${k}: ${r.headers[k]}, expected ${v}`);
  if (c.expect.text !== undefined && text !== c.expect.text) wrong.push(`body ${JSON.stringify(text)}, expected ${JSON.stringify(c.expect.text)}`);
  if (c.expect.bytes !== undefined && text !== c.expect.bytes) wrong.push(`bytes ${JSON.stringify(text)}, expected ${JSON.stringify(c.expect.bytes)}`);
  if (c.expect.json !== undefined || c.expect.words !== undefined) {
    let body: { words?: Record<string, unknown> } | undefined;
    try {
      body = JSON.parse(text);
    } catch {
      wrong.push(`body isn't JSON: ${text.slice(0, 80)}`);
    }
    if (body && c.expect.json !== undefined && !holds(body, c.expect.json)) wrong.push(`body ${text.slice(0, 300)} doesn't hold ${JSON.stringify(c.expect.json)}`);
    if (body && c.expect.words !== undefined) {
      const keys = Object.keys(body.words ?? {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify([...c.expect.words].sort())) wrong.push(`words ${keys.join(',')}, expected ${c.expect.words.join(',')}`);
      for (const [k, v] of Object.entries(body.words ?? {})) if (typeof v !== 'string' || v === '') wrong.push(`words.${k} isn't a sentence`);
    }
  }
  return wrong;
}
