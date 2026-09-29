// The local web face's rules (contract §1.1, §3 serve, §7; web-local build notes, slice 3), through the transport-free
// handler: every guard refuses before anything is looked up and before any of the body is read; the routes are the
// operations whose faces include web, as own keys; a result, error or not, is 200 in the envelope; pairing trades its
// code once; files by fingerprint sit behind the same guards; every response carries the fixed headers.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, Words, renderError } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { settingsFrom } from '../src/settings.ts';
import { createHandler, POLICY, type WebRequest } from '../src/web/handler.ts';
import { open, seed } from './seed.ts';
import { PROCESS_TEST_MS, place, type Place } from './server.ts';
import { vi } from 'vitest';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });

const PORT = 4321;
const HOST = `127.0.0.1:${PORT}`;
const ORIGIN = `http://${HOST}`;
const CODE = 'pairing-code-for-tests';
const W = Words.load();

/** A body that yields these bytes. */
async function* bytes(text: string): AsyncIterable<Buffer> {
  yield Buffer.from(text);
}
/** A body that fails the test if anything reads it. */
function untouched(): AsyncIterable<Buffer> & { read: boolean } {
  const b = {
    read: false,
    async *[Symbol.asyncIterator]() {
      b.read = true;
      yield Buffer.alloc(0);
    },
  };
  return b;
}

/** A fixture home with setup's developers (config.json), a seeded catalog, and a handler paired once. */
async function served(o: { publish?: boolean; config?: Record<string, unknown> | null } = {}) {
  const p = place();
  await seed(p);
  mkdirSync(p.home, { recursive: true });
  if (o.config !== null) writeFileSync(join(p.home, 'config.json'), JSON.stringify(o.config ?? { me: 'dev1', demo_developers: ['dev2'] }));
  const settings = settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, p.dir);
  const h = createHandler({ port: PORT, pairingCode: CODE, publish: o.publish ?? false, settings, words: W });
  const paired = await h.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code: CODE })) });
  const token = JSON.parse(String(paired.body)).data.token as string;
  return { p, h, token, settings };
}

function base(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { host: HOST, origin: ORIGIN, 'content-type': 'application/json', ...extra };
}
const api = (token: string, op: string, body: unknown, headers: Record<string, string | undefined> = {}, as = 'dev1'): WebRequest => ({
  method: 'POST',
  path: `/api/v1/${op}`,
  headers: base({ 'x-skills-catalog-token': token, 'x-skills-catalog-as': as, ...headers }),
  body: bytes(JSON.stringify(body)),
});
const json = (r: { body: string | Buffer }) => JSON.parse(String(r.body));

describe('the guards: each refuses before anything is looked up or read', () => {
  it('Host must be exactly 127.0.0.1:<port> (403)', async () => {
    const { h, token } = await served();
    for (const host of [undefined, `localhost:${PORT}`, '127.0.0.1:1', '127.0.0.1', 'evil.example']) {
      const body = untouched();
      const r = await h.handle({ ...api(token, 'search_shared_skills', {}), headers: base({ host, 'x-skills-catalog-token': token, 'x-skills-catalog-as': 'dev1' }), body });
      expect([r.status, body.read], String(host)).toEqual([403, false]);
    }
  });

  it('only POST on /api (405)', async () => {
    const { h, token } = await served();
    for (const method of ['GET', 'PUT', 'DELETE', 'OPTIONS']) {
      const body = untouched();
      const r = await h.handle({ ...api(token, 'search_shared_skills', {}), method, body });
      expect([r.status, body.read], method).toEqual([405, false]);
    }
  });

  it('Content-Type application/json only, with at most charset=utf-8 (415)', async () => {
    const { h, token } = await served();
    for (const ct of [undefined, 'text/plain', 'application/json; charset=latin1', 'application/jsonx', 'multipart/form-data']) {
      const body = untouched();
      const r = await h.handle({ ...api(token, 'search_shared_skills', {}, { 'content-type': ct }), body });
      expect([r.status, body.read], String(ct)).toEqual([415, false]);
    }
    for (const ct of ['application/json', 'application/json; charset=utf-8', 'Application/JSON; Charset=UTF-8']) {
      const r = await h.handle(api(token, 'search_shared_skills', {}, { 'content-type': ct }));
      expect(r.status, ct).toBe(200);
    }
  });

  it('Origin exactly http://127.0.0.1:<port> on a POST, missing included (403)', async () => {
    const { h, token } = await served();
    for (const origin of [undefined, 'null', `http://localhost:${PORT}`, 'http://127.0.0.1:1', 'https://127.0.0.1:4321', 'http://evil.example']) {
      const body = untouched();
      const r = await h.handle({ ...api(token, 'search_shared_skills', {}, { origin }), body });
      expect([r.status, body.read], String(origin)).toEqual([403, false]);
    }
  });

  it('the session token on every call (401), whatever its length', async () => {
    const { h, token } = await served();
    for (const t of [undefined, '', 'x', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), token + 'x']) {
      const body = untouched();
      const r = await h.handle({ ...api(token, 'search_shared_skills', {}, { 'x-skills-catalog-token': t }), body });
      expect([r.status, body.read], String(t)).toEqual([401, false]);
    }
  });
});

describe('the routes', () => {
  it('only an operation served on the web, as an own key: anything else is the fixed 404, body unread', async () => {
    const { h, token } = await served();
    for (const op of ['nothing_here', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'install_shared_skill', 'publish_skill_to_catalog', 'list_installed_skills']) {
      const body = untouched();
      const r = await h.handle({ ...api(token, op, {}), body });
      expect([r.status, body.read, String(r.body)], op).toEqual([404, false, POLICY.notFound]);
    }
    for (const path of ['/', '/index.html', '/api', '/api/search_shared_skills', '/api/v2/search_shared_skills']) {
      const r = await h.handle({ ...api(token, 'x', {}), path });
      expect([r.status, String(r.body)], path).toEqual([404, POLICY.notFound]);
    }
  });

  it('a result is 200 {ok: true, data}: the core\'s typed result, with the acting line as a field', async () => {
    const { p, h, token } = await served();
    const r = await h.handle(api(token, 'search_shared_skills', { query: 'release notes' }));
    expect(r.status).toBe(200);
    const c = await open(p);
    try {
      expect(json(r)).toEqual({ ok: true, data: await c.search({ query: 'release notes' }), acting_as: W.format(W.word('acting_as'), { developer: 'dev1' }) });
    } finally {
      c.close();
    }
  });

  it('an error is 200 {ok: false, error: {code, ...data}} with the sentence every face shows', async () => {
    const { h, token } = await served();
    const r = await h.handle(api(token, 'list_shared_skill_versions', { name: 'no-such-skill' }));
    expect(r.status).toBe(200);
    const b = json(r);
    expect(b.ok).toBe(false);
    expect(b.error.code).toBe('not_found');
    expect(b.sentence).toBe(renderError(W, new CatalogError('not_found', b.error)).trim());
  });
});

describe('the fixed headers', () => {
  it('on every response, the refusals included; no-store on /api; never any Access-Control-*', async () => {
    const { h, token } = await served();
    const responses = [
      await h.handle(api(token, 'search_shared_skills', {})),
      await h.handle({ ...api(token, 'search_shared_skills', {}), headers: base({ host: 'evil' }) }),
      await h.handle({ ...api(token, 'search_shared_skills', {}), method: 'GET' }),
      await h.handle(api(token, 'nothing_here', {})),
      await h.handle({ ...api(token, 'x', {}), path: '/' }),
    ];
    for (const r of responses) {
      for (const [k, v] of Object.entries(POLICY.headers)) expect(r.headers[k], `${r.status} ${k}`).toBe(v);
      expect(Object.keys(r.headers).filter((k) => k.toLowerCase().startsWith('access-control-')), String(r.status)).toEqual([]);
    }
    expect(responses[0]!.headers['cache-control']).toBe('no-store');
  });
});

describe('the body', () => {
  it('a body that never ends is cut at the limit: too_large in the envelope, never a 413, never held whole', async () => {
    const { h, token } = await served();
    let pulled = 0;
    const endless = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const chunk = Buffer.alloc(64 * 1024, 0x20);
          pulled += chunk.length;
          yield chunk;
        }
      },
    };
    const started = Date.now();
    const r = await h.handle({ ...api(token, 'search_shared_skills', {}), body: endless });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.status).toBe(200);
    expect(json(r).error.code).toBe('too_large');
    expect(pulled).toBeLessThanOrEqual(POLICY.bodyLimit + 64 * 1024);
  });

  it('a body that isn\'t JSON is a request it can\'t take, in the envelope', async () => {
    const { h, token } = await served();
    const r = await h.handle({ ...api(token, 'search_shared_skills', {}), body: bytes('{not json') });
    expect([r.status, json(r).ok, json(r).error.code]).toEqual([200, false, 'invalid_request']);
  });
});

describe('who is acting (contract §7): setup\'s me or one of its demo developers', () => {
  it('a known developer acts; a missing, malformed or unknown one does not', async () => {
    const { h, token } = await served();
    expect(json(await h.handle(api(token, 'search_shared_skills', {}, {}, 'dev2'))).ok).toBe(true);
    const code = async (as: string | undefined) => json(await h.handle({ ...api(token, 'search_shared_skills', {}), headers: base({ 'x-skills-catalog-token': token, 'x-skills-catalog-as': as }) })).error?.code;
    expect(await code(undefined)).toBe('unauthenticated');
    expect(await code('Bad Name')).toBe('invalid_request');
    expect(await code('dev3')).toBe('unauthenticated');
  });

  it('with no developers set up, no one acts', async () => {
    const { h, token } = await served({ config: null });
    expect(json(await h.handle(api(token, 'search_shared_skills', {}))).error.code).toBe('unauthenticated');
  });
});

describe('publishing from the web', () => {
  const file = (text: string) => ({ path: 'SKILL.md', mode: 0o644, content_base64: Buffer.from(text).toString('base64') });
  const skill = (name: string, body = 'Body.\n') => ({ name, files: [file(`---\nname: ${name}\ndescription: A web publish.\n---\n${body}`)] });

  it('without --publish, a dry run works and a real publish is forbidden (read_only)', async () => {
    const { h, token } = await served();
    expect(json(await h.handle(api(token, 'publish_version', { ...skill('web-skill'), dry_run: true }))).ok).toBe(true);
    const r = json(await h.handle(api(token, 'publish_version', skill('web-skill'))));
    expect([r.ok, r.error.code, r.error.why]).toEqual([false, 'forbidden', 'read_only']);
  });

  it('the person-only override is no input on the web, and a planted secret is still refused', async () => {
    const { h, token } = await served({ publish: true });
    const r = json(await h.handle(api(token, 'publish_version', { ...skill('web-secret', 'Use AKIAIOSFODNN7EXAMPLE.\n'), allow_suspected_secrets: true })));
    expect([r.ok, r.error.code, r.error.why]).toEqual([false, 'invalid_request', 'unknown_field']);
    const s = json(await h.handle(api(token, 'publish_version', skill('web-secret', 'Use AKIAIOSFODNN7EXAMPLE.\n'))));
    expect([s.ok, s.error.code]).toEqual([false, 'secret_suspected']);
  });

  it('with --publish, two interleaved publishes as different developers each land as their own', async () => {
    const { p, h, token } = await served({ publish: true });
    const [a, b] = await Promise.all([h.handle(api(token, 'publish_version', skill('web-one'), {}, 'dev1')), h.handle(api(token, 'publish_version', skill('web-two'), {}, 'dev2'))]);
    expect([json(a).ok, json(b).ok]).toEqual([true, true]);
    const c = await open(p);
    try {
      expect((await c.versions({ name: 'web-one' })).versions[0]!.publisher).toBe('dev1');
      expect((await c.versions({ name: 'web-two' })).versions[0]!.publisher).toBe('dev2');
    } finally {
      c.close();
    }
  });
});

describe('pairing (outside the versioned API)', () => {
  it('trades its code once: a second trade or a wrong code is 401', async () => {
    const { h } = await served();
    const trade = (code: string) => h.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code })) });
    expect((await trade(CODE)).status).toBe(401);   // served() already traded it
    const fresh = createHandler({ port: PORT, pairingCode: CODE, publish: false, settings: settingsFrom({ SKILLS_HOME: '/nonexistent-home' }), words: W });
    expect((await fresh.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code: 'wrong' })) })).status).toBe(401);
    expect((await fresh.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code: CODE })) })).status).toBe(200);
  });

  it('is behind Host, Origin and Content-Type like every /api call', async () => {
    const fresh = createHandler({ port: PORT, pairingCode: CODE, publish: false, settings: settingsFrom({ SKILLS_HOME: '/nonexistent-home' }), words: W });
    const trade = (headers: Record<string, string | undefined>) => fresh.handle({ method: 'POST', path: '/api/pair', headers: base(headers), body: bytes(JSON.stringify({ code: CODE })) });
    expect((await trade({ host: 'evil' })).status).toBe(403);
    expect((await trade({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await trade({ 'content-type': 'text/plain' })).status).toBe(415);
    expect((await trade({})).status).toBe(200);   // none of those used it up
  });
});

describe('a version\'s files by fingerprint (GET /api/v1/files/<sha256>)', () => {
  it('serves the bytes behind the guards: token always, Origin exact when sent, Sec-Fetch-Site same-origin when sent', async () => {
    const { p, h, token } = await served();
    const c = await open(p);
    let sha: string;
    try {
      const read = await c.read({ names: ['release-notes-kit'], include: 'files' });
      sha = (read.skills[0] as { files: { path: string; sha256: string }[] }).files.find((x) => x.path === 'SKILL.md')!.sha256;
    } finally {
      c.close();
    }
    const get = (headers: Record<string, string | undefined>, path = `/api/v1/files/${sha}`) =>
      h.handle({ method: 'GET', path, headers: { host: HOST, 'x-skills-catalog-token': token, ...headers }, body: untouched() });
    const ok = await get({});
    expect(ok.status).toBe(200);
    expect(Buffer.from(ok.body as Buffer).toString('utf8')).toContain('name: release-notes-kit');
    expect((await get({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await get({ origin: 'http://evil.example' })).status).toBe(403);
    expect((await get({ 'sec-fetch-site': 'cross-site' })).status).toBe(403);
    expect((await get({ 'x-skills-catalog-token': undefined })).status).toBe(401);
    expect((await get({ host: 'evil' })).status).toBe(403);
    for (const bad of [sha.toUpperCase(), sha.slice(1), `${sha}0`, 'z'.repeat(64), '0'.repeat(64)]) expect((await get({}, `/api/v1/files/${bad}`)).status, bad).toBe(404);
  });
});
