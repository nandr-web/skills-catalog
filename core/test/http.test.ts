// The web API's transport-free half (contract §1.1), run the way a transport runs it: route, then the catalog's answer
// (an operation's envelope, or a file's), with the shared cases every transport answers the same. The guards are each
// transport's own; their numbers come from here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/catalog.ts';
import { CatalogError } from '../src/errors.ts';
import { dispatch, effectOf, fileResponse, operationResponse, refuse, route, STATUS, type FileAnswer, type HttpResponse } from '../src/http/index.ts';
import { OPERATIONS, webRow, type OutputSchema } from '../src/api.ts';
import { renderError } from '../src/render.ts';
import { Words } from '../src/words-file.ts';
import { ERROR_CODES } from '../src/errors.ts';
import { conforms } from './conforms.ts';
import { checkHttpCase, FILE_CSP, HTTP_DEVELOPER, HTTP_SEED, httpCases, skillMd, type HttpCase } from './http-cases.ts';
import { openTest } from './helpers.ts';

const W = Words.load();
const b64 = (text: string) => Buffer.from(text).toString('base64');

async function seeded(): Promise<Catalog> {
  const { catalog } = await openTest();
  for (const s of HTTP_SEED) {
    await catalog.publish({ name: s.name, files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd(s.name, s.description)) }] }, { actor: async () => HTTP_DEVELOPER }, 'cli');
  }
  return catalog;
}

/** A transport past its guards: the core's route, then the catalog's answer. A file case's catalog answers only its
 *  fingerprint's lookup, and fails the case if a malformed one reaches it. */
async function answer(c: HttpCase, catalog: Catalog): Promise<HttpResponse> {
  if (c.refuse) return refuse(c.refuse, { words: W, ...(c.challenge ? { challenge: c.challenge } : {}) });
  const req = c.request!;
  const r = route(req.method, req.path, 'local');
  switch (r.kind) {
    case 'operation': {
      const raw = req.body === 'cut' ? 'cut' : new TextEncoder().encode(req.body ?? '');
      return operationResponse({ op: r.op, raw, catalog, developer: HTTP_DEVELOPER, words: W });
    }
    case 'file': {
      const files = { file: async (sha: string): Promise<FileAnswer> => (c.file ? c.file : Promise.reject(new Error(`looked up ${sha}`))) };
      return fileResponse(files, r.sha256);
    }
    case 'method':
      return refuse('method', { words: W, allow: r.allow });
    default:   // not_found, and pairing (the local page's own, not the API's)
      return refuse('not_found', { words: W });
  }
}

describe('the shared cases', () => {
  for (const c of httpCases) {
    it(c.name, async () => {
      const catalog = await seeded();
      try {
        expect(checkHttpCase(c, await answer(c, catalog))).toEqual([]);
      } finally {
        catalog.close();
      }
    });
  }
});

describe('the published schemas (docs/api/openapi.local.json, openapi.hosted.json) say what these answer', () => {
  type Schema = {
    paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    components: { schemas: { Words: { properties: Record<string, unknown> } } };
  };
  const load = (f: string) => JSON.parse(readFileSync(new URL(`../../docs/api/${f}`, import.meta.url), 'utf8')) as Schema;
  const local = load('openapi.local.json');
  const hosted = load('openapi.hosted.json');
  // A link to a file and a file on its way are answers only a hosted catalog gives; everything else, both do.
  const schemaOf = (c: HttpCase) => (c.file?.kind === 'link' || c.file?.kind === 'on_its_way' ? hosted : local);
  const pathOf = (path: string) => (path.startsWith('/api/v1/files/') ? '/api/v1/files/{sha256}' : path);
  const routed = httpCases.filter((c) => c.request && local.paths[pathOf(c.request.path)]);
  const everyRouteLacks = (schema: Schema, status: number) =>
    Object.entries(schema.paths).flatMap(([p, ms]) => Object.entries(ms).filter(([, o]) => !(String(status) in o.responses)).map(([m]) => `${m} ${p}`));

  it('each status a route answers is one its schema declares; a method it doesn\'t declare is 405', async () => {
    expect(routed.length).toBeGreaterThan(10);
    const catalog = await seeded();
    try {
      const undeclared: string[] = [];
      for (const c of routed) {
        const r = await answer(c, catalog);
        const operation = schemaOf(c).paths[pathOf(c.request!.path)]![c.request!.method.toLowerCase()];
        const declared = operation ? Object.keys(operation.responses) : ['405'];
        if (!declared.includes(String(r.status))) undeclared.push(`${c.request!.method} ${pathOf(c.request!.path)} ${r.status}`);
      }
      expect([...new Set(undeclared)]).toEqual([]);
    } finally {
      catalog.close();
    }
  });

  // The published <op>_envelope is generated from the operation's output schema and the error codes: each answer is
  // checked against those, with the repo's own schema checker.
  it('each envelope\'s data fits its operation\'s output schema, and each error\'s code is a published one', async () => {
    const catalog = await seeded();
    try {
      let checked = 0;
      for (const c of routed) {
        const r = await answer(c, catalog);
        if (!String(r.headers['content-type']).startsWith('application/json')) continue;
        const body = JSON.parse(String(r.body)) as { ok: boolean; data?: unknown; error?: { code: string } };
        const op = c.request!.path.slice('/api/v1/'.length);
        if (body.ok) expect(conforms(OPERATIONS[op]!.output as OutputSchema, body.data), c.name).toEqual([]);
        else expect(ERROR_CODES, c.name).toContain(body.error!.code);
        checked++;
      }
      expect(checked).toBeGreaterThan(4);
    } finally {
      catalog.close();
    }
  });

  it('each envelope has only the published keys, and words only the published words', async () => {
    const catalog = await seeded();
    try {
      const wordKeys = Object.keys(local.components.schemas.Words.properties);
      for (const c of [...routed, ...httpCases.filter((x) => x.refuse === 'token_only' || x.challenge)]) {
        const r = await answer(c, catalog);
        if (!String(r.headers['content-type']).startsWith('application/json')) continue;
        const body = JSON.parse(String(r.body)) as Record<string, unknown>;
        expect(Object.keys(body).filter((k) => !['ok', body['ok'] ? 'data' : 'error', 'words'].includes(k)), c.name).toEqual([]);
        expect(Object.keys((body['words'] ?? {}) as object).filter((k) => !wordKeys.includes(k)), c.name).toEqual([]);
      }
    } finally {
      catalog.close();
    }
  });

  it('the hosted schema declares a 401 on every route (sign-in, with its challenge)', () => {
    expect(everyRouteLacks(hosted, STATUS.no_token)).toEqual([]);
  });

  // Contract §1.1: the act-as header on a hosted catalog is 400 (token_only) on every /api/v1 route, files included.
  it('the hosted schema declares a 400 (token_only) on every route', () => {
    expect(everyRouteLacks(hosted, STATUS.token_only)).toEqual([]);
  });
});

// The web build notes' fixed headers, written out here so a weakened one (a CSP of default-src *) fails.
const FIXED_HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};

describe('every response', () => {
  it('carries the fixed security headers and never any Access-Control-*', async () => {
    const catalog = await seeded();
    try {
      for (const c of httpCases) {
        const r = await answer(c, catalog);
        const expected = c.file?.kind === 'bytes' ? { ...FIXED_HEADERS, 'content-security-policy': FILE_CSP } : FIXED_HEADERS;
        for (const [k, v] of Object.entries(expected)) expect(r.headers[k], `${c.name} ${k}`).toBe(v);
        expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-')), c.name).toEqual([]);
      }
    } finally {
      catalog.close();
    }
  });
});

describe('the refusals\' numbers', () => {
  it('one table: 401, 403, 404, 405, 415 and 400 token_only; the files route\'s 302 and 503', () => {
    expect(STATUS).toEqual({ no_token: 401, refused: 403, not_found: 404, method: 405, not_json: 415, token_only: 400, link: 302, on_its_way: 503 });
  });
});

describe('route', () => {
  it('knows the pairing path, and leaves an unknown operation to the transport to refuse after its token check', () => {
    expect(route('POST', '/api/pair', 'local')).toEqual({ kind: 'pair' });
    expect(route('POST', '/api/v1/nothing_here', 'local')).toEqual({ kind: 'not_found', operationPath: true });
    expect(route('POST', '/', 'local')).toEqual({ kind: 'not_found', operationPath: false });
    expect(route('GET', '/api/v1/search_shared_skills', 'local')).toEqual({ kind: 'method', allow: 'POST' });
    expect(route('POST', `/api/v1/files/${'a'.repeat(64)}`, 'local')).toEqual({ kind: 'method', allow: 'GET' });
  });

  it('routes an operation exactly when the API\'s one rule (webRow) serves it on that kind of catalog', () => {
    for (const where of ['local', 'hosted'] as const) {
      for (const op of [...Object.keys(OPERATIONS), 'constructor', '__proto__', 'toString']) {
        expect(route('POST', `/api/v1/${op}`, where).kind === 'operation', `${where} ${op}`).toBe(webRow(op, where));
      }
    }
  });
});

describe('effectOf', () => {
  it('says what an operation does, so a read-only caller is refused a write before dispatch', () => {
    expect(effectOf('publish_version', 'hosted')).toBe('writes_catalog');
    expect(effectOf('search_shared_skills', 'local')).toBe('reads');
    expect(effectOf('constructor', 'local')).toBeUndefined();
    expect(effectOf('install_shared_skill', 'local')).toBeUndefined();
  });
});

describe('dispatch', () => {
  it('passes publish the acting developer as its identity and the face after it; the others the face', async () => {
    const catalog = await seeded();
    try {
      const skill = { name: 'dispatched', files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('dispatched', 'Through dispatch.')) }] };
      expect(await dispatch('publish_version', skill, { catalog, developer: 'dev2', face: 'web' })).toMatchObject({ publisher: 'dev2', version: 1 });
      await expect(dispatch('publish_version', { ...skill, allow_suspected_secrets: true }, { catalog, developer: 'dev2', face: 'web' })).rejects.toMatchObject({ code: 'invalid_request', data: { field: 'allow_suspected_secrets', why: 'unknown_field' } });
      expect(await dispatch('publish_version', { ...skill, dry_run: true, allow_suspected_secrets: true }, { catalog, developer: 'dev2', face: 'cli' })).toMatchObject({ dry_run: true });
      expect(await dispatch('search_shared_skills', { query: 'dispatched' }, { catalog, developer: undefined, face: 'mcp' })).toMatchObject({ total_matches: 1 });
    } finally {
      catalog.close();
    }
  });

  it('with no developer, a publish is unauthenticated', async () => {
    const catalog = await seeded();
    try {
      const skill = { name: 'nobody', files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('nobody', 'No one.')) }] };
      await expect(dispatch('publish_version', skill, { catalog, developer: undefined, face: 'web' })).rejects.toMatchObject({ code: 'unauthenticated' });
    } finally {
      catalog.close();
    }
  });
});

describe('operationResponse', () => {
  it('words an error with the words file; a transport overrides only unauthenticated', async () => {
    const catalog = await seeded();
    try {
      const nobody = { op: 'publish_version', raw: new TextEncoder().encode(JSON.stringify({ name: 'x', files: [] })), catalog, developer: undefined, words: W };
      const plain = JSON.parse(String((await operationResponse(nobody)).body));
      expect(plain.words.error).toBe(renderError(W, new CatalogError('unauthenticated', {})));
      const local = JSON.parse(String((await operationResponse({ ...nobody, unauthenticated: 'set one up' })).body));
      expect(local.words.error).toBe('set one up');
      const other = JSON.parse(String((await operationResponse({ ...nobody, developer: 'dev1', raw: new TextEncoder().encode('{') , unauthenticated: 'set one up' })).body));
      expect(other.words.error).toBe(renderError(W, new CatalogError('invalid_request', { field: 'body', why: 'not_json' })));
    } finally {
      catalog.close();
    }
  });

  it('runs the transport\'s own run when it gives one (the local log), and lets a bug through to the transport', async () => {
    const catalog = await seeded();
    try {
      const seen: string[] = [];
      const run = async (op: string, input: unknown) => (seen.push(op), dispatch(op, input, { catalog, developer: 'dev1', face: 'web' }));
      const ok = await operationResponse({ op: 'search_shared_skills', raw: new TextEncoder().encode('{}'), developer: 'dev1', words: W, run, where: 'local' });
      expect([ok.status, seen]).toEqual([200, ['search_shared_skills']]);
      const bug = () => operationResponse({ op: 'search_shared_skills', raw: new TextEncoder().encode('{}'), developer: 'dev1', words: W, where: 'local', run: async () => { throw new TypeError('a bug'); } });
      await expect(bug()).rejects.toThrow(TypeError);
    } finally {
      catalog.close();
    }
  });
});
