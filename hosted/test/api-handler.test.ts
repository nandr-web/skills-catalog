// The hosted API's handler (contract §1.1), transport-free: the web API's shared cases answered on a hosted catalog on the
// stand-in, then what only hosted adds: who's asking comes from the Bearer token, checked before anything under /api/v1/
// is looked up or read, so an unknown caller learns nothing of what exists; the acting-as header is refused; a read-scope
// token is refused whatever changes the catalog, before it runs.

import { createHash } from 'node:crypto';
import { OPERATIONS, Words } from '@skills-catalog/core';
import { HTTP_DEVELOPER, HTTP_SEED, SHA, checkHttpCase, httpCases, skillMd } from '@skills-catalog/core/testing/http';
import { API_HEADERS, SECURITY_HEADERS, type FileAnswer } from '@skills-catalog/core/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostedHandler, type HostedRequest } from '../src/api/handler.ts';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createStores, HostedTokenStore, type Place, type TokenHolder } from '../src/index.ts';
import { hostedAdapter } from './adapter.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

const words = Words.load();
const HOLDERS: Record<string, TokenHolder> = {
  't-dev1': { owner: HTTP_DEVELOPER, scope: 'publish', kind: 'personal' },
  't-reader': { owner: 'reader', scope: 'read', kind: 'session' },
};
// Every request here came through the edge; the origin guard's own tests are api-origin.test.ts.
const THROUGH_THE_EDGE = { allows: async () => true };

async function world(file: (sha256: string) => Promise<FileAnswer> = async () => ({ kind: 'unknown' })) {
  const store = hostedAdapter(() => emu!.endpoint).store();
  const catalog = await store.open();
  const b64 = (text: string) => Buffer.from(text).toString('base64');
  for (const s of HTTP_SEED) {
    await catalog.publish({ name: s.name, files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd(s.name, s.description)) }] }, { actor: async () => HTTP_DEVELOPER }, 'web');
  }
  const looked: string[] = [];
  const asked: string[] = [];
  const handler = createHostedHandler({
    catalog,
    tokens: { verify: async (t) => (looked.push(t), HOLDERS[t]) },
    words,
    origin: THROUGH_THE_EDGE,
    file: async (sha) => (asked.push(sha), file(sha)),
  });
  return { handler, looked, asked, close: () => catalog.close() };
}

const req = (r: { method: string; path: string; body?: string | 'cut' }, headers: Record<string, string | undefined> = { authorization: 'Bearer t-dev1' }): HostedRequest => ({
  method: r.method,
  path: r.path,
  headers,
  body: r.body === 'cut' ? 'cut' : new TextEncoder().encode(r.body ?? ''),
});

describe("the web API's shared cases, hosted", () => {
  for (const c of httpCases.filter((c) => c.request)) {
    it(c.name, async () => {
      const w = await world(async () => c.file ?? { kind: 'unknown' });
      try {
        const r = await w.handler.handle(req(c.request!));
        expect(checkHttpCase(c, r)).toEqual([]);
        // A malformed fingerprint never reaches the catalog.
        if (c.request!.path.startsWith('/api/v1/files/') && !c.file) expect(w.asked).toEqual([]);
      } finally {
        w.close();
      }
    }, 30_000);
  }
});

describe('the files route, hosted, answered by the catalog', () => {
  it('without a file part the handler asks the catalog: a published file is a link (302), an unknown one 404', async () => {
    const catalog = await hostedAdapter(() => emu!.endpoint).store().open();
    try {
      const s = HTTP_SEED[0]!;
      await catalog.publish({ name: s.name, files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd(s.name, s.description)).toString('base64') }] }, { actor: async () => HTTP_DEVELOPER }, 'web');
      const published = createHash('sha256').update(skillMd(s.name, s.description)).digest('hex');
      const handler = createHostedHandler({ catalog, tokens: { verify: async (t) => HOLDERS[t] }, words, origin: THROUGH_THE_EDGE });
      // The test catalog runs the names indexer right after each publish.
      const r = await handler.handle(req({ method: 'GET', path: `/api/v1/files/${published}` }));
      expect(r.status).toBe(302);
      expect(r.headers['location']).toContain(published);
      expect((await handler.handle(req({ method: 'GET', path: `/api/v1/files/${'f'.repeat(64)}` }))).status).toBe(404);
    } finally {
      catalog.close();
    }
  }, 30_000);
});

describe('a revoked token, from the real token store', () => {
  it('works until it is revoked, then is 401 at once, on an operation and on the files route, before anything is read', async () => {
    const place: Place = { table: 'handler-tokens', bucket: 'handler-tokens' };
    const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
    const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true });
    try {
      await createStores(ddb, s3, place);
      const store = new HostedTokenStore({ ddb, place, clock: { now: () => new Date() } });
      const token = await store.issue({ owner: HTTP_DEVELOPER, scope: 'publish', kind: 'personal', expiresAt: new Date(Date.now() + 3_600_000) });
      const touched: string[] = [];
      const handler = createHostedHandler({
        catalog: new Proxy({}, { get: (_, k) => (touched.push(String(k)), () => Promise.resolve({ results: [] })) }) as never,
        tokens: store,
        words,
        origin: THROUGH_THE_EDGE,
        file: async (s) => (touched.push(`file ${s}`), { kind: 'unknown' }),
      });
      const search = req({ method: 'POST', path: '/api/v1/search_shared_skills', body: '{"query":"x"}' }, { authorization: `Bearer ${token}` });
      const file = req({ method: 'GET', path: `/api/v1/files/${'a'.repeat(64)}` }, { authorization: `Bearer ${token}` });
      expect((await handler.handle(search)).status).toBe(200);
      await store.revoke(token);
      touched.length = 0;
      expect((await handler.handle(search)).status).toBe(401);
      expect((await handler.handle(file)).status).toBe(401);
      expect(touched).toEqual([]);
    } finally {
      ddb.destroy();
      s3.destroy();
    }
  }, 30_000);
});

describe('who is asking, hosted', () => {
  const search = { method: 'POST', path: '/api/v1/search_shared_skills', body: '{"query":"release"}' };

  it('no token: 401 with the Bearer challenge and unauthenticated in the envelope, before anything is looked up or read', async () => {
    const w = await world();
    try {
      for (const r0 of [search, { method: 'POST', path: '/api/v1/no_such_operation', body: '{}' }, { method: 'GET', path: `/api/v1/files/${SHA}` }]) {
        const r = await w.handler.handle(req(r0, {}));
        expect(r.status, r0.path).toBe(401);
        expect(r.headers['www-authenticate']).toBe('Bearer');
        expect(JSON.parse(String(r.body))).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
      }
      expect(w.looked).toEqual([]);
      expect(w.asked).toEqual([]);
    } finally {
      w.close();
    }
  }, 30_000);

  it('a token the store does not know: 401, and an unknown operation answers the same, so nothing leaks', async () => {
    const w = await world();
    try {
      const a = await w.handler.handle(req(search, { authorization: 'Bearer t-nobody' }));
      const b = await w.handler.handle(req({ method: 'POST', path: '/api/v1/no_such_operation', body: '{}' }, { authorization: 'Bearer t-nobody' }));
      expect([a.status, b.status]).toEqual([401, 401]);
      expect(b.body).toEqual(a.body);
    } finally {
      w.close();
    }
  }, 30_000);

  it('the acting-as header: 400 invalid_request token_only, before any lookup, with or without a token', async () => {
    const w = await world();
    try {
      for (const headers of [{ authorization: 'Bearer t-dev1', 'x-skills-catalog-as': 'bo' }, { 'x-skills-catalog-as': 'bo' }]) {
        const r = await w.handler.handle(req(search, headers));
        expect(r.status).toBe(400);
        expect(JSON.parse(String(r.body))).toMatchObject({ ok: false, error: { code: 'invalid_request', field: 'X-Skills-Catalog-As', why: 'token_only' } });
      }
      expect(w.looked).toEqual([]);
    } finally {
      w.close();
    }
  }, 30_000);

  it('the developer acting is the token holder: a publish by the token of dev1 acts as dev1', async () => {
    const w = await world();
    try {
      const body = JSON.stringify({ name: 'hosted-published', dry_run: true, files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd('hosted-published', 'From the hosted API.')).toString('base64') }] });
      const r = await w.handler.handle(req({ method: 'POST', path: '/api/v1/publish_version', body }));
      expect(JSON.parse(String(r.body))).toMatchObject({ ok: true, data: { publisher: HTTP_DEVELOPER } });
    } finally {
      w.close();
    }
  }, 30_000);

  it('a read-scope token reads, and is forbidden read_scope anything that changes the catalog, in the envelope, before it runs', async () => {
    const w = await world();
    try {
      const ok = await w.handler.handle(req(search, { authorization: 'Bearer t-reader' }));
      expect(JSON.parse(String(ok.body))).toMatchObject({ ok: true });
      const writes = Object.values(OPERATIONS).filter((o) => o.faces.includes('web') && o.effect === 'writes_catalog');
      expect(writes.length).toBeGreaterThan(0);
      for (const o of writes) {
        // A body that would fail the operation's own checks: forbidden comes first, so it never ran.
        const r = await w.handler.handle(req({ method: 'POST', path: `/api/v1/${o.name}`, body: '{not json' }, { authorization: 'Bearer t-reader' }));
        expect(r.status, o.name).toBe(200);
        expect(JSON.parse(String(r.body)), o.name).toMatchObject({ ok: false, error: { code: 'forbidden', why: 'read_scope' } });
      }
    } finally {
      w.close();
    }
  }, 30_000);

  it('/api/pair is not a hosted route: the fixed 404', async () => {
    const w = await world();
    try {
      const r = await w.handler.handle(req({ method: 'POST', path: '/api/pair', body: '{}' }));
      expect(r.status).toBe(404);
    } finally {
      w.close();
    }
  }, 30_000);

  it('a bug is internal_error in the envelope, never a stack trace; the log gets where it happened, never its message or the token', async () => {
    const w = await world();
    const logged: string[] = [];
    const broken = createHostedHandler({ catalog: new Proxy({}, { get: () => () => Promise.reject(new Error('skill text: release notes body')) }) as never, tokens: { verify: async (t) => HOLDERS[t] }, words, origin: THROUGH_THE_EDGE, file: async () => ({ kind: 'unknown' }), log: (l) => logged.push(l) });
    try {
      const r = await broken.handle(req(search));
      expect(r.status).toBe(200);
      expect(String(r.body)).not.toContain('release notes body');
      expect(JSON.parse(String(r.body))).toMatchObject({ ok: false, error: { code: 'internal_error' }, words: { error: expect.any(String) } });
      // The log gets where it happened, never the error's message (it could carry skill text) or the token.
      expect(logged.length).toBe(1);
      expect(logged[0]).toContain('internal_error');
      expect(logged[0]).toMatch(/at /);
      expect(logged[0]).not.toContain('release notes body');
      expect(logged[0]).not.toContain('t-dev1');
    } finally {
      w.close();
    }
  }, 30_000);
});

describe('the headers on every hosted answer', () => {
  it("each kind of answer (200, 302, 400, 401, 403, 404, 503, read_scope, internal_error) carries the core's security headers and no-store, and never an Access-Control-* header", async () => {
    const w = await world(async (sha) => (sha === 'b'.repeat(64) ? { kind: 'on_its_way' } : sha === 'c'.repeat(64) ? { kind: 'link', url: 'https://example.test/x' } : { kind: 'unknown' }));
    const search = { method: 'POST', path: '/api/v1/search_shared_skills', body: '{"query":"release"}' };
    const refusing = createHostedHandler({ catalog: {} as never, tokens: { verify: async () => undefined }, words, origin: { allows: async () => false } });
    const broken = createHostedHandler({ catalog: new Proxy({}, { get: () => () => Promise.reject(new Error('bug')) }) as never, tokens: { verify: async (t) => HOLDERS[t] }, words, origin: THROUGH_THE_EDGE, log: () => {} });
    try {
      const answers = {
        ok: await w.handler.handle(req(search)),
        link: await w.handler.handle(req({ method: 'GET', path: `/api/v1/files/${'c'.repeat(64)}` })),
        token_only: await w.handler.handle(req(search, { authorization: 'Bearer t-dev1', 'x-skills-catalog-as': 'bo' })),
        no_token: await w.handler.handle(req(search, {})),
        origin: await refusing.handle(req(search)),
        not_found: await w.handler.handle(req({ method: 'GET', path: `/api/v1/files/${'f'.repeat(64)}` })),
        outside: await w.handler.handle(req({ method: 'GET', path: '/elsewhere' })),
        method: await w.handler.handle(req({ method: 'GET', path: '/api/v1/search_shared_skills' })),
        on_its_way: await w.handler.handle(req({ method: 'GET', path: `/api/v1/files/${'b'.repeat(64)}` })),
        read_scope: await w.handler.handle(req({ method: 'POST', path: '/api/v1/publish_version', body: '{}' }, { authorization: 'Bearer t-reader' })),
        internal_error: await broken.handle(req(search)),
      };
      expect(Object.fromEntries(Object.entries(answers).map(([k, r]) => [k, r.status]))).toEqual({ ok: 200, link: 302, token_only: 400, no_token: 401, origin: 403, not_found: 404, outside: 404, method: 405, on_its_way: 503, read_scope: 200, internal_error: 200 });
      expect(answers.method.headers['allow']).toBe('POST');
      for (const [kind, r] of Object.entries(answers)) {
        for (const [h, v] of Object.entries({ ...SECURITY_HEADERS, ...API_HEADERS })) expect(r.headers[h], `${kind} ${h}`).toBe(v);
        expect(Object.keys(r.headers).filter((h) => h.toLowerCase().startsWith('access-control-')), kind).toEqual([]);
      }
    } finally {
      w.close();
    }
  }, 30_000);
});
