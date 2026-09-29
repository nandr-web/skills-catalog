// The hosted API's handler (contract §1.1), transport-free: the web API's shared cases answered on a hosted catalog on the
// stand-in, then what only hosted adds: who's asking comes from the Bearer token, checked before anything under /api/v1/
// is looked up or read, so an unknown caller learns nothing of what exists; the acting-as header is refused; a read-scope
// token is refused whatever changes the catalog, before it runs.

import { OPERATIONS, Words } from '@skills-catalog/core';
import { HTTP_DEVELOPER, HTTP_SEED, SHA, checkHttpCase, httpCases, skillMd } from '@skills-catalog/core/testing/http';
import type { FileAnswer } from '@skills-catalog/core/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostedHandler, type HostedRequest } from '../src/api/handler.ts';
import type { TokenHolder } from '../src/index.ts';
import { hostedAdapter } from './adapter.ts';
import { startEmulator, type Emulator } from './emulator.ts';

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

  it('a bug is internal_error in the envelope, never a stack trace, and the words say it is a bug', async () => {
    const w = await world();
    const broken = createHostedHandler({ catalog: new Proxy({}, { get: () => () => Promise.reject(new Error('a secret-looking stack')) }) as never, tokens: { verify: async (t) => HOLDERS[t] }, words, file: async () => ({ kind: 'unknown' }) });
    try {
      const r = await broken.handle(req(search));
      expect(r.status).toBe(200);
      expect(String(r.body)).not.toContain('secret-looking');
      expect(JSON.parse(String(r.body))).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    } finally {
      w.close();
    }
  }, 30_000);
});
