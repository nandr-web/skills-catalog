// The local web face's rules (contract §1.1, §3 serve, §7; web-local build notes, slice 3), through the transport-free
// handler: every guard refuses before anything is looked up and before any of the body is read; the routes are the
// operations whose faces include web, as own keys; a result, error or not, is 200 in the envelope; pairing trades its
// code once; files by fingerprint sit behind the same guards; every response carries the fixed headers.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actAs, Words } from '@skills-catalog/core';
import { checkHttpCase, HTTP_DEVELOPER, HTTP_SEED, httpCases, skillMd as sharedSkillMd } from '@skills-catalog/core/testing/http';
import { describe, expect, it } from 'vitest';
import { logWords } from '../src/activity.ts';
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
/**
 * A body that never ends, bounded: a reader that goes past its cut gets an error at 4x the limit (`overran` set), so a
 * test fails at once instead of filling memory or hanging (a generator that never yields to the event loop starves any
 * timer).
 */
function endless(): AsyncIterable<Buffer> & { pulled: number; overran: boolean } {
  const b = {
    pulled: 0,
    overran: false,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (b.pulled >= 4 * POLICY.bodyLimit) {
          b.overran = true;
          throw new Error('the body was read past its cut');
        }
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        b.pulled += chunk.length;
        yield chunk;
      }
    },
  };
  return b;
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
async function served(o: { publish?: boolean; config?: Record<string, unknown> | null; env?: Record<string, string> } = {}) {
  const p = place();
  await seed(p);
  mkdirSync(p.home, { recursive: true });
  if (o.config !== null) writeFileSync(join(p.home, 'config.json'), JSON.stringify(o.config ?? { me: 'dev1', demo_developers: ['dev2'] }));
  const settings = settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, ...o.env }, p.dir);
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
const json = (r: { body: string | Uint8Array }) => JSON.parse(typeof r.body === 'string' ? r.body : new TextDecoder().decode(r.body));

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
    for (const t of [undefined, '', 'x', token.slice(0, 8), token.slice(0, -1), token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), token + 'x']) {
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
    // Without the token, an unknown operation is refused like a known one: an unpaired caller learns nothing of what exists.
    for (const op of ['nothing_here', 'install_shared_skill']) expect((await h.handle(api('', op, {}))).status, op).toBe(401);
    for (const path of ['/', '/index.html', '/api', '/api/search_shared_skills', '/api/v2/search_shared_skills']) {
      const r = await h.handle({ ...api(token, 'x', {}), path });
      expect([r.status, String(r.body)], path).toEqual([404, POLICY.notFound]);
    }
  });

});

// The web API's shared cases (core/test/http-cases.ts), through this whole handler with every guard passed: the same
// answers the hosted handler gives. A file case's answer is a fake there, so the local files route has its own test
// below; the guards' refusals are this handler's own tests above.
describe('the shared cases, through the local handler', () => {
  async function sharedServed() {
    const p = place();
    const c = await open(p);
    try {
      for (const s of HTTP_SEED) await c.publish({ name: s.name, files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(sharedSkillMd(s.name, s.description)).toString('base64') }] }, actAs(HTTP_DEVELOPER));
    } finally {
      c.close();
    }
    mkdirSync(p.home, { recursive: true });
    writeFileSync(join(p.home, 'config.json'), JSON.stringify({ me: HTTP_DEVELOPER }));
    const settings = settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, p.dir);
    const h = createHandler({ port: PORT, pairingCode: CODE, publish: false, settings, words: W });
    const paired = await h.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code: CODE })) });
    return { h, token: JSON.parse(String(paired.body)).data.token as string };
  }

  for (const c of httpCases.filter((x) => x.request && !x.file && !x.request.path.startsWith('/api/v1/files/'))) {
    it(c.name, async () => {
      const { h, token } = await sharedServed();
      const req = c.request!;
      const body = req.body === 'cut' ? endless() : bytes(req.body ?? '');
      const r = await h.handle({ method: req.method, path: req.path, headers: base({ 'x-skills-catalog-token': token, 'x-skills-catalog-as': HTTP_DEVELOPER }), body });
      expect('overran' in body && body.overran, 'the body was read past its cut').toBe(false);
      expect(checkHttpCase(c, r)).toEqual([]);
    });
  }
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
      await h.handle(api('wrong', 'search_shared_skills', {})),
      await h.handle(api(token, 'search_shared_skills', {}, { 'content-type': 'text/plain' })),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 403, 405, 404, 404, 401, 415]);
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
    const body = endless();
    const r = await h.handle({ ...api(token, 'search_shared_skills', {}), body }).catch((e: Error) => e);
    expect(body.overran, 'the body was read past its cut').toBe(false);
    if (r instanceof Error) throw r;
    expect(r.status).toBe(200);
    expect(json(r).error.code).toBe('too_large');
    expect(body.pulled).toBeLessThanOrEqual(POLICY.bodyLimit + 64 * 1024);
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

  it('who is acting is checked before any of the body is read, with --publish or without', async () => {
    for (const publish of [false, true]) {
      const { h, token } = await served({ publish });
      for (const as of [undefined, 'Bad Name', 'dev3']) {
        const body = untouched();
        const r = await h.handle({ ...api(token, 'search_shared_skills', {}, { 'x-skills-catalog-as': as }), body });
        expect([json(r).ok, body.read], `${as} publish=${publish}`).toEqual([false, false]);
      }
    }
  });

  it('with no developers set up, no one acts', async () => {
    const { h, token } = await served({ config: null });
    expect(json(await h.handle(api(token, 'search_shared_skills', {}))).error.code).toBe('unauthenticated');
  });

  it('the same source as the MCP server and the CLI: SKILLS_AS, else setup\'s me, else the login, plus the demo developers', async () => {
    const asked = async (o: Parameters<typeof served>[0], as: string) => {
      const { h, token } = await served(o);
      const r = json(await h.handle(api(token, 'search_shared_skills', {}, {}, as)));
      return r.ok ? 'ok' : r.error.code;
    };
    expect(await asked({ config: null, env: { USER: 'nan' } }, 'nan')).toBe('ok');
    expect(await asked({ config: null, env: { USER: 'nan' } }, 'dev1')).toBe('unauthenticated');
    expect(await asked({ config: null, env: { SKILLS_AS: 'ana', USER: 'nan' } }, 'ana')).toBe('ok');
    expect(await asked({ config: null, env: { SKILLS_AS: 'ana', USER: 'nan' } }, 'nan')).toBe('unauthenticated');
    expect(await asked({ config: { me: 'dev1', demo_developers: ['dev2'] }, env: { USER: 'nan' } }, 'nan')).toBe('unauthenticated');
    expect(await asked({ config: { me: 'dev1', demo_developers: ['dev2'] }, env: { USER: 'nan' } }, 'dev2')).toBe('ok');
  });
});

describe('publishing from the web', () => {
  const file = (text: string) => ({ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(text).toString('base64') });
  const skill = (name: string, body = 'Body.\n') => ({ name, files: [file(`---\nname: ${name}\ndescription: A web publish.\n---\n${body}`)] });

  it('without --publish, a dry run works and a real publish is forbidden (read_only)', async () => {
    const { h, token } = await served();
    expect(json(await h.handle(api(token, 'publish_version', { ...skill('web-skill'), dry_run: true }))).ok).toBe(true);
    const r = json(await h.handle(api(token, 'publish_version', skill('web-skill'))));
    expect([r.ok, r.error.code, r.error.why]).toEqual([false, 'forbidden', 'read_only']);
  });

  it('without --publish, the person-only override is still refused first, as an unknown field on the web', async () => {
    const { h, token } = await served();
    const r = json(await h.handle(api(token, 'publish_version', { ...skill('web-skill'), allow_suspected_secrets: true })));
    expect([r.ok, r.error.code, r.error.field, r.error.why]).toEqual([false, 'invalid_request', 'allow_suspected_secrets', 'unknown_field']);
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

  it('a missing Origin is refused (403), and that leaves the code unused', async () => {
    const fresh = createHandler({ port: PORT, pairingCode: CODE, publish: false, settings: settingsFrom({ SKILLS_HOME: '/nonexistent-home' }), words: W });
    const trade = (headers: Record<string, string | undefined>) => fresh.handle({ method: 'POST', path: '/api/pair', headers: base(headers), body: bytes(JSON.stringify({ code: CODE })) });
    expect((await trade({ origin: undefined })).status).toBe(403);
    expect((await trade({})).status).toBe(200);
  });

  it('a pairing body past 4 KiB is 401 even with the right code, and leaves the code unused', async () => {
    const fresh = createHandler({ port: PORT, pairingCode: CODE, publish: false, settings: settingsFrom({ SKILLS_HOME: '/nonexistent-home' }), words: W });
    const exact = JSON.stringify({ code: CODE, pad: '' });
    const padded = JSON.stringify({ code: CODE, pad: 'x'.repeat(4097 - exact.length) });
    expect(Buffer.byteLength(padded)).toBe(4097);
    expect((await fresh.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(padded) })).status).toBe(401);
    expect((await fresh.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code: CODE })) })).status).toBe(200);
  });

  it('a wrong code\'s answer holds neither the code sent nor the real one', async () => {
    const fresh = createHandler({ port: PORT, pairingCode: CODE, publish: false, settings: settingsFrom({ SKILLS_HOME: '/nonexistent-home' }), words: W });
    const SENT = 'sent-code-3b7e19';
    const r = await fresh.handle({ method: 'POST', path: '/api/pair', headers: base(), body: bytes(JSON.stringify({ code: SENT })) });
    expect(r.status).toBe(401);
    for (const secret of [SENT, CODE]) expect(JSON.stringify(r.headers) + String(r.body ?? ''), secret).not.toContain(secret);
  });
});

describe('what the web face shows and logs of a failure', () => {
  it('a real publish refused without --publish reaches the activity log, like any other error', async () => {
    const { p, h, token } = await served();
    const body = { name: 'web-skill', files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from('---\nname: web-skill\ndescription: A web publish.\n---\nBody.\n').toString('base64') }] };
    expect(json(await h.handle(api(token, 'publish_version', body))).error.why).toBe('read_only');
    const last = readFileSync(join(p.home, 'activity.log'), 'utf8').trim().split('\n').at(-1)!;
    expect(last).toContain('publish_version');
    expect(last).toContain(logWords(W).error('forbidden'));
  });

  it('a bug names only its log\'s file, never a path on this machine', async () => {
    // A folder where config.json should be: reading it fails in a way nothing expects, so it's internal_error.
    const { p, h, token } = await served({ config: null });
    mkdirSync(join(p.home, 'config.json'));
    const r = json(await h.handle(api(token, 'search_shared_skills', {})));
    expect(r.error.code).toBe('internal_error');
    expect(String(r.error.log)).not.toContain('/');
    expect(JSON.stringify(r)).not.toContain(p.dir);
  });
});

describe('a version\'s files by fingerprint (GET /api/v1/files/<sha256>)', () => {
  it('a catalog that can\'t be opened is the fixed 404, never a failure', async () => {
    const { p, h, token } = await served();
    writeFileSync(join(p.catalogDir, 'catalog.sqlite'), 'not a database\n'.repeat(200));
    const r = await h.handle({ method: 'GET', path: `/api/v1/files/${'a'.repeat(64)}`, headers: { host: HOST, 'x-skills-catalog-token': token }, body: untouched() });
    expect([r.status, String(r.body)]).toEqual([404, POLICY.notFound]);
  });

  async function files() {
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
    return { sha, get };
  }

  it('behind the guards, each refusing before any lookup: Host, Origin exact when sent, Sec-Fetch-Site same-origin when sent, the token always; a malformed fingerprint is never looked up', async () => {
    const { sha, get } = await files();
    expect((await get({ origin: 'http://evil.example' })).status).toBe(403);
    for (const site of ['cross-site', 'same-site', 'none']) expect((await get({ 'sec-fetch-site': site })).status, site).toBe(403);
    expect((await get({ 'x-skills-catalog-token': undefined })).status).toBe(401);
    expect((await get({ 'x-skills-catalog-token': 'wrong' })).status).toBe(401);
    expect((await get({ host: 'evil' })).status).toBe(403);
    for (const bad of [sha.toUpperCase(), sha.slice(1), `${sha}0`, 'z'.repeat(64)]) expect((await get({}, `/api/v1/files/${bad}`)).status, bad).toBe(404);
  });

  it('serves a stored file\'s bytes (same-origin headers or none), and a fingerprint no version names is the fixed 404', async () => {
    const { get } = await files();
    const ok = await get({});
    expect(ok.status).toBe(200);
    expect(ok.headers['content-disposition']).toBe('attachment');
    expect(Buffer.from(ok.body as Uint8Array).toString('utf8')).toContain('name: release-notes-kit');
    expect((await get({ origin: ORIGIN, 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await get({}, `/api/v1/files/${'0'.repeat(64)}`)).status).toBe(404);
  });
});
