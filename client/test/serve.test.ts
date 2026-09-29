// skills-catalog serve (contract §3; the web-local build notes, slice 3), over a real socket on 127.0.0.1: the order of
// its checks (a terminal, then a local catalog, before anything is made), where it listens, its one printed line, and
// what a whole session leaves behind: nothing but what perform writes (the activity log, usage counts, error logs), a
// catalog untouched without --publish, a missing catalog never created, and the pairing code and session token nowhere
// but the printed line and the one pairing answer.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer, connect } from 'node:net';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actAs, Words } from '@skills-catalog/core';
import { describe, expect, it, vi } from 'vitest';
import { cliWords } from '../src/cli/words.ts';
import { runServe, type ServeIo } from '../src/cli/serve.ts';
import { settingsFrom } from '../src/settings.ts';
import { POLICY } from '../src/web/handler.ts';
import { serve } from '../src/web/serve.ts';
import { open, request as skillRequest, seed, skillMd } from './seed.ts';
import { PROCESS_TEST_MS, place, type Place } from './server.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });

const S = cliWords(Words.load());
const env = (p: Place, extra: Record<string, string> = {}) => ({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, ...extra });

/** serve with its output captured; `line` resolves with the printed line, `stop()` ends it and resolves its exit code. */
function start(argv: string[], e: Record<string, string>, o: { tty?: boolean; pairingCode?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let stop!: () => void;
  const stopped = new Promise<void>((r) => (stop = r));
  let printed!: (line: string) => void;
  const line = new Promise<string>((r) => (printed = r));
  const io: ServeIo = {
    env: e,
    cwd: '/',
    tty: o.tty ?? true,
    stdout: (t) => (out.push(t), printed(t)),
    stderr: (t) => void err.push(t),
    stopped,
    ...(o.pairingCode ? { pairingCode: o.pairingCode } : {}),
  };
  const code = runServe(argv, S, io, 'usage\n');
  return { out, err, line, code, stop: async () => (stop(), code) };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
function call(port: number, o: { method?: string; path: string; headers?: Record<string, string>; body?: string }): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: o.method ?? 'POST', path: o.path, headers: o.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(o.body);
  });
}
const portOf = (line: string) => Number(/^http:\/\/127\.0\.0\.1:(\d+)\/#p=/.exec(line)![1]);
const codeOf = (line: string) => /#p=([^\s]+)/.exec(line)![1]!;
const page = (port: number) => ({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/json' });

async function paired(port: number, code: string): Promise<string> {
  const r = await call(port, { path: '/api/pair', headers: page(port), body: JSON.stringify({ code }) });
  expect(r.status).toBe(200);
  return JSON.parse(r.body).data.token as string;
}
const configure = (p: Place) => {
  mkdirSync(p.home, { recursive: true });
  writeFileSync(join(p.home, 'config.json'), JSON.stringify({ me: 'dev1' }));
};

/** Every file under a folder, with its bytes. */
function files(dir: string): Map<string, string> {
  const all = new Map<string, string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) all.set(relative(dir, f), readFileSync(f, 'latin1'));
    }
  };
  walk(dir);
  return all;
}

/** A catalog folder's content: every file but SQLite's reader bookkeeping. A read-only open of a catalog in WAL mode makes
 *  the shared-memory index (-shm) and an empty write-ahead log (-wal); neither holds any of the catalog's data, and the
 *  log must stay empty. */
function catalogContent(dir: string): Map<string, string> {
  const all = files(dir);
  for (const [f, bytes] of all) {
    if (f.endsWith('.sqlite-shm')) all.delete(f);
    if (f.endsWith('.sqlite-wal')) {
      expect(bytes.length, `${f} holds writes`).toBe(0);
      all.delete(f);
    }
  }
  return all;
}

describe('before anything is made', () => {
  it('with no terminal, refuses (exit 3) in the person-only words, and starts nothing', async () => {
    const p = place();
    const s = start(['--publish'], env(p), { tty: false });
    expect(await s.code).toBe(3);
    expect(s.out).toEqual([]);
    expect(s.err.join('')).toBe(S.format(S.word('errors.person_only_serve'), { command: `${S.cli} serve --publish` }) + '\n');
    expect(existsSync(p.dir) ? files(p.dir).size : 0).toBe(0);
    // The command is rebuilt from what serve accepted, never echoed as typed.
    const typed = start(['--publish', '--port=08080'], env(p), { tty: false });
    expect(await typed.code).toBe(3);
    expect(typed.err.join('')).toContain(`: ${S.cli} serve --port 8080 --publish\n`);
  });

  it('refuses a catalog that isn\'t a local folder (exit 1), in the core\'s own words', async () => {
    const p = place();
    for (const catalog of ['https://catalog.example/team', 'ftp://catalog.example']) {
      const s = start([], env(p, { SKILLS_CATALOG: catalog }));
      expect(await s.code, catalog).toBe(1);
      expect(s.out, catalog).toEqual([]);
      expect(s.err.join(''), catalog).toMatch(/^(forbidden|invalid_request):/);
    }
  });

  it('takes only --port N and --publish', async () => {
    const p = place();
    for (const argv of [['--port'], ['--port', 'x'], ['--port', '70000'], ['--host', '0.0.0.0'], ['extra']]) {
      const s = start(argv, env(p));
      expect(await s.code, argv.join(' ')).toBe(1);
      expect(s.out, argv.join(' ')).toEqual([]);
    }
  });
});

describe('where it listens', () => {
  it('on 127.0.0.1 only, a free port by default, printing one line: the page with its pairing code', async () => {
    const p = place();
    configure(p);
    await seed(p);
    const s = start([], env(p));
    const line = await s.line;
    try {
      expect(line).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#p=[A-Za-z0-9_-]{22}\n$/);
      const port = portOf(line);
      expect(port).toBeGreaterThan(0);
      // Not on the IPv6 loopback, nor any other address.
      await expect(new Promise((resolve, reject) => connect({ host: '::1', port }).on('connect', resolve).on('error', reject))).rejects.toThrow();
      expect((await call(port, { path: '/api/v1/search_shared_skills', headers: page(port), body: '{}' })).status).toBe(401);
    } finally {
      expect(await s.stop()).toBe(0);
    }
    expect(s.out).toEqual([line]);
    expect(s.err).toEqual([]);
  });

  it('--port N that\'s taken exits 1 and never falls back to another', async () => {
    const p = place();
    const taken = createServer();
    await new Promise<void>((r) => taken.listen({ host: '127.0.0.1', port: 0 }, r));
    const port = (taken.address() as { port: number }).port;
    try {
      const s = start(['--port', String(port)], env(p));
      expect(await s.code).toBe(1);
      expect(s.out).toEqual([]);
      expect(s.err.join('')).toBe(S.format(S.word('errors.port_in_use'), { port }) + '\n');
    } finally {
      taken.close();
    }
  });
});

describe('the server itself (web/serve.ts)', () => {
  const settingsOf = (p: Place) => settingsFrom(env(p), p.dir);

  it('listens on 127.0.0.1 alone, with limits on slow requests and on connections', async () => {
    const p = place();
    const s = await serve({ port: 0, publish: false, settings: settingsOf(p), words: S });
    try {
      expect((s.server.address() as { address: string }).address).toBe('127.0.0.1');
      expect([s.server.headersTimeout, s.server.requestTimeout, s.server.maxConnections]).toEqual([10_000, 30_000, 64]);
    } finally {
      await s.close();
    }
  });

  it('a request the handler fails on is a bare 500 with the fixed headers, never stored, and its connection closed', async () => {
    const p = place();
    const s = await serve({ port: 0, publish: false, settings: settingsOf(p), words: S, handle: async () => Promise.reject(new TypeError('a bug')) });
    try {
      const r = await call(s.port, { path: '/api/v1/search_shared_skills', headers: page(s.port), body: '{}' });
      expect([r.status, r.body, r.headers['cache-control'], r.headers['x-content-type-options'], r.headers['content-security-policy']]).toEqual([500, '', 'no-store', 'nosniff', POLICY.headers['content-security-policy']]);
    } finally {
      await s.close();
    }
  });
});

describe('a session over the socket', () => {
  it('pairs once, answers as the web face, and refuses a request without its token before reading its body', async () => {
    const p = place();
    configure(p);
    await seed(p);
    const s = start([], env(p));
    const port = portOf(await s.line);
    try {
      const token = await paired(port, codeOf(await s.line));
      expect((await call(port, { path: '/api/pair', headers: page(port), body: JSON.stringify({ code: codeOf(await s.line) }) })).status).toBe(401);
      const ok = await call(port, { path: '/api/v1/search_shared_skills', headers: { ...page(port), 'x-skills-catalog-token': token, 'x-skills-catalog-as': 'dev1' }, body: JSON.stringify({ query: 'release notes' }) });
      expect([ok.status, JSON.parse(ok.body).ok, ok.headers['cache-control'], ok.headers['x-content-type-options']]).toEqual([200, true, 'no-store', 'nosniff']);
      expect(Object.keys(ok.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
      // A large body sent without the token: refused, and the connection dropped rather than the body read.
      const refused = await call(port, { path: '/api/v1/search_shared_skills', headers: page(port), body: 'x'.repeat(4 * 1024 * 1024) }).catch((e: NodeJS.ErrnoException) => ({ status: e.code }));
      expect([401, 'ECONNRESET', 'EPIPE']).toContain(refused.status);
    } finally {
      await s.stop();
    }
  });

  it('a request refused before its body is read closes its connection, so the next request (on a kept-alive client) is still answered', async () => {
    const p = place();
    configure(p);
    await seed(p);
    const s = start([], env(p));
    const port = portOf(await s.line);
    try {
      const as = { ...page(port), 'x-skills-catalog-token': await paired(port, codeOf(await s.line)), 'x-skills-catalog-as': 'dev1' };
      const refused = await call(port, { path: '/api/v1/nothing_here', headers: as, body: '{}' });
      expect([refused.status, refused.headers['connection']]).toEqual([404, 'close']);
      expect((await call(port, { path: '/api/v1/search_shared_skills', headers: as, body: '{}' })).status).toBe(200);
    } finally {
      await s.stop();
    }
  });

  it('a planted code, token and marker are never in a file, a log or a later answer, wherever the marker was sent', async () => {
    const p = place();
    configure(p);
    const MARKER = 'planted-marker-7f3a9c';
    const CODE = 'PLANTEDCODE9d2e41b7c0aa';
    await seed(p, async (c) => void (await c.publish(skillRequest('marked-skill', [{ path: 'SKILL.md', text: skillMd('marked-skill', 'Carries a marker.', `${MARKER}\n`) }]), actAs('dev1'))));
    const before = catalogContent(p.catalogDir);
    const s = start([], env(p), { pairingCode: CODE });
    const port = portOf(await s.line);
    const answers: Reply[] = [];
    let token: string;
    try {
      token = await paired(port, CODE);
      const as = { ...page(port), 'x-skills-catalog-token': token, 'x-skills-catalog-as': 'dev1' };
      const dryRun = { name: 'web-marked', message: MARKER, dry_run: true, files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd('web-marked', 'A dry run.', `${MARKER}\n`)).toString('base64') }] };
      // The marker in a stored skill's body (served back: answer 0), a dry run's file and message, an unknown key, and
      // the act-as header; the others are what fails: a body that isn't JSON, an operation no one serves, a second pairing.
      answers.push(await call(port, { path: '/api/v1/read_shared_skill', headers: as, body: JSON.stringify({ names: ['marked-skill'], include: 'contents' }) }));
      answers.push(await call(port, { path: '/api/v1/publish_version', headers: as, body: JSON.stringify(dryRun) }));
      answers.push(await call(port, { path: '/api/v1/search_shared_skills', headers: as, body: JSON.stringify({ query: 'x', [MARKER]: MARKER }) }));
      answers.push(await call(port, { path: '/api/v1/search_shared_skills', headers: { ...as, 'x-skills-catalog-as': MARKER }, body: '{}' }));
      answers.push(await call(port, { path: '/api/v1/search_shared_skills', headers: as, body: '{not json' }));
      answers.push(await call(port, { path: '/api/v1/nothing_here', headers: as, body: '{}' }));
      answers.push(await call(port, { path: '/api/pair', headers: page(port), body: JSON.stringify({ code: CODE }) }));
    } finally {
      await s.stop();
    }
    expect(answers[0]!.body).toContain(MARKER);   // it was served
    expect(JSON.parse(answers[1]!.body)).toMatchObject({ ok: true, data: { dry_run: true } });
    for (const [i, a] of answers.entries()) {
      for (const secret of [CODE, token]) expect(JSON.stringify(a.headers) + a.body, `answer ${i}`).not.toContain(secret);
    }
    // Every file under the place (the home, the assistant's home, the catalog): none holds the code or the token; only
    // the catalog holds the marker, as it did before the session (the dry run stored nothing).
    const after = files(p.dir);
    const catalog = relative(p.dir, p.catalogDir);
    expect(after.size).toBeGreaterThan(0);
    for (const [f, bytes] of after) {
      for (const secret of [CODE, token]) expect(bytes.includes(secret), f).toBe(false);
      if (!f.startsWith(catalog)) expect(bytes.includes(MARKER), f).toBe(false);
    }
    expect(catalogContent(p.catalogDir)).toEqual(before);
    expect(s.out.join('').split(CODE).length - 1).toBe(1);
    expect(s.out.join('')).not.toContain(token);
    expect(s.err).toEqual([]);
  });
});

describe('what a session writes', () => {
  it('without --publish: the catalog untouched; only the activity log, the usage counts and error logs change', async () => {
    const p = place();
    configure(p);
    await seed(p);
    const before = files(p.dir);
    const catalogBefore = catalogContent(p.catalogDir);
    const s = start([], env(p));
    const port = portOf(await s.line);
    try {
      const as = { ...page(port), 'x-skills-catalog-token': await paired(port, codeOf(await s.line)), 'x-skills-catalog-as': 'dev1' };
      await call(port, { path: '/api/v1/search_shared_skills', headers: as, body: '{}' });
      await call(port, { path: '/api/v1/publish_version', headers: as, body: JSON.stringify({ name: 'web-skill', files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd('web-skill', 'A web publish.')).toString('base64') }] }) });
      const dry = await call(port, { path: '/api/v1/publish_version', headers: as, body: JSON.stringify({ name: 'web-skill', dry_run: true, files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(skillMd('web-skill', 'A dry run.')).toString('base64') }] }) });
      expect(JSON.parse(dry.body)).toMatchObject({ ok: true, data: { dry_run: true } });   // a dry run stores nothing either
    } finally {
      await s.stop();
    }
    expect(catalogContent(p.catalogDir)).toEqual(catalogBefore);
    const after = files(p.dir);
    const changed = [...after.keys()].filter((f) => before.get(f) !== after.get(f));
    const home = relative(p.dir, p.home);
    const catalog = relative(p.dir, p.catalogDir);
    expect(changed.filter((f) => !(f === join(home, 'activity.log') || f.startsWith(join(home, 'usage')) || f.startsWith(join(home, 'logs')) || f.startsWith(catalog)))).toEqual([]);
    expect(changed).toContain(join(home, 'activity.log'));
    expect([...before.keys()].filter((f) => !after.has(f))).toEqual([]);
  });

  it('never creates a catalog that isn\'t there', async () => {
    const p = place();
    configure(p);
    const missing = join(p.dir, 'no-catalog-here');
    const s = start([], env(p, { SKILLS_CATALOG: pathToFileURL(missing).href }));
    const port = portOf(await s.line);
    try {
      const as = { ...page(port), 'x-skills-catalog-token': await paired(port, codeOf(await s.line)), 'x-skills-catalog-as': 'dev1' };
      const r = await call(port, { path: '/api/v1/search_shared_skills', headers: as, body: '{}' });
      expect(r.status).toBe(200);
    } finally {
      await s.stop();
    }
    expect(existsSync(missing)).toBe(false);
    void statSync;
  });
});
