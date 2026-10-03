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
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
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
    expect(s.out).toEqual([line, S.format(S.word('person.serve.started')) + '\n']);
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

  it('the bare address says what it serves (the API only; the page is phase 2), as plain text (review V6.2)', async () => {
    const p = place();
    const s = await serve({ port: 0, publish: false, settings: settingsOf(p), words: S });
    try {
      const r = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(await r.text()).toBe(S.format(S.word('person.serve.root')) + '\n');
    } finally {
      await s.close();
    }
  });

  it('holds no connection past its cap: one more is closed at once (the cap lowered to 2 for the test)', async () => {
    const p = place();
    const s = await serve({ port: 0, publish: false, settings: settingsOf(p), words: S });
    const open = (): Promise<{ sock: ReturnType<typeof connect>; closed: Promise<boolean> }> =>
      new Promise((resolve) => {
        const sock = connect({ host: '127.0.0.1', port: s.port });
        sock.on('error', () => undefined);
        const closed = new Promise<boolean>((r) => {
          const t = setTimeout(() => r(false), 1_000);
          sock.on('close', () => (clearTimeout(t), r(true)));
        });
        sock.on('connect', () => resolve({ sock, closed }));
      });
    try {
      s.server.maxConnections = 2;
      const held = [await open(), await open()];
      const third = await open();
      expect(await third.closed, 'the third connection').toBe(true);
      expect(await Promise.race([held[0]!.closed, held[1]!.closed]), 'the two held').toBe(false);
      for (const h of held) h.sock.destroy();
    } finally {
      await s.close();
    }
  });

  it('a request the handler fails on is a bare 500 with the fixed headers, never stored, and its connection closed', async () => {
    const p = place();
    const s = await serve({ port: 0, publish: false, settings: settingsOf(p), words: S, handle: async () => Promise.reject(new TypeError('a bug')) });
    try {
      const r = await call(s.port, { path: '/api/v1/search_shared_skills', headers: page(s.port), body: '{}' });
      expect([r.status, r.body, r.headers['cache-control'], r.headers['connection']]).toEqual([500, '', 'no-store', 'close']);
      expect(Object.keys(POLICY.headers)).toHaveLength(5);
      for (const [k, v] of Object.entries(POLICY.headers)) expect(r.headers[k], k).toBe(v);
      expect(Object.keys(r.headers).filter((k) => k.startsWith('access-control-'))).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

/** A full garbage collection, for measuring what's held (V8's gc exposed to this test process only). */
function collect(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

type Raw = { status: number; head: string; body: string; closed: boolean };
/** Writes these exact bytes on a fresh socket; resolves with what came back once the server closes it, or after `ms`
 *  with `closed: false` (the socket then destroyed). The only way to send what node:http won't: a header twice. */
function raw(port: number, bytes: string, ms = 2_000): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sock = connect({ host: '127.0.0.1', port });
    const done = (closed: boolean) => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      const at = text.indexOf('\r\n\r\n');
      const head = at < 0 ? text : text.slice(0, at);
      let body = at < 0 ? '' : text.slice(at + 4);
      if (/^transfer-encoding: chunked$/im.test(head)) body = dechunk(body);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0), head: head.toLowerCase(), body, closed });
      sock.destroy();
    };
    const timer = setTimeout(() => done(false), ms);
    sock.on('data', (c: Buffer) => chunks.push(c));
    sock.on('close', () => done(true));
    sock.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? undefined : reject(e)));
    sock.write(bytes);
  });
}
/** A chunked body's data: each chunk's size line, then that many bytes, until the 0 chunk. */
function dechunk(s: string): string {
  let out = '';
  for (let i = 0; ; ) {
    const eol = s.indexOf('\r\n', i);
    const size = parseInt(s.slice(i, eol), 16);
    if (!(size > 0)) return out;
    out += s.slice(eol + 2, eol + 2 + size);
    i = eol + 2 + size + 2;
  }
}
/** A request's bytes: its header lines as given (a name may repeat), then the body. */
const bytesOf = (path: string, lines: string[], body = '') => `POST ${path} HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n${body}`;

/** serve started on a seeded catalog and paired once: its port, token, and the headers a page's request carries. */
async function session() {
  const p = place();
  configure(p);
  await seed(p);
  const s = start([], env(p));
  const port = portOf(await s.line);
  const code = codeOf(await s.line);
  const token = await paired(port, code);
  const lines = (o: { host?: readonly string[]; type?: readonly string[]; origin?: readonly string[]; token?: readonly string[]; length?: number } = {}) => [
    ...(o.host ?? [`127.0.0.1:${port}`]).map((v) => `Host: ${v}`),
    ...(o.origin ?? [`http://127.0.0.1:${port}`]).map((v) => `Origin: ${v}`),
    ...(o.type ?? ['application/json']).map((v) => `Content-Type: ${v}`),
    ...(o.token ?? [token]).map((v) => `X-Skills-Catalog-Token: ${v}`),
    'X-Skills-Catalog-As: dev1',
    ...(o.length === undefined ? [] : [`Content-Length: ${o.length}`]),
  ];
  return { s, port, code, token, lines };
}

describe('hostile input over a raw socket (contract §1.1)', () => {
  it('a repeated Host, Content-Type, Origin or token header is refused, never read as its first value', async () => {
    const { s, port, lines } = await session();
    const SEARCH = '/api/v1/search_shared_skills';
    try {
      const own = `127.0.0.1:${port}`;
      const plain = await raw(port, bytesOf(SEARCH, lines({ length: 2 }), '{}'));
      expect(plain.status, 'the same request, each header once').toBe(200);
      for (const [label, o, status] of [
        ['Host twice', { host: [own, 'evil.example'] }, 403],
        ['Host twice, both its own', { host: [own, own] }, 403],
        ['Origin twice', { origin: [`http://${own}`, 'http://evil.example'] }, 403],
        ['Content-Type twice', { type: ['application/json', 'text/plain'] }, 415],
        ['the token twice', { token: ['x', 'y'] }, 401],
      ] as const) {
        const r = await raw(port, bytesOf(SEARCH, lines({ ...o, length: 2 }), '{}'));
        expect(r.status, label).toBe(status);
      }
    } finally {
      await s.stop();
    }
  });

  it('a body past the limit (by one byte, or by megabytes still being sent) is answered too_large in the envelope, then the connection closed within 2 s', async () => {
    const { s, port, lines } = await session();
    try {
      for (const n of [POLICY.bodyLimit + 1, 2 * POLICY.bodyLimit]) {
        const r = await raw(port, bytesOf('/api/v1/search_shared_skills', lines({ length: n }), ' '.repeat(n)));
        expect([r.status, r.closed], `${n} bytes: ${r.head.split('\r\n')[0]}`).toEqual([200, true]);
        expect(JSON.parse(r.body).error, `${n} bytes`).toMatchObject({ code: 'too_large', limit: 'request_bytes' });
      }
    } finally {
      await s.stop();
    }
  });

  it('a sender that trickles on past the limit: answered too_large, then closed within 2 s all the same', async () => {
    const { s, port, lines } = await session();
    try {
      const t0 = Date.now();
      const r = await new Promise<{ status: number; closed: boolean }>((resolve) => {
        const got: Buffer[] = [];
        const sock = connect({ host: '127.0.0.1', port });
        const finish = (closed: boolean) => {
          clearTimeout(timer);
          clearInterval(drip);
          resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(Buffer.concat(got).toString('utf8'))?.[1] ?? 0), closed });
          sock.destroy();
        };
        const timer = setTimeout(() => finish(false), 4_000);
        sock.on('data', (c: Buffer) => got.push(c));
        sock.on('close', () => finish(true));
        sock.on('error', () => undefined);
        sock.write(bytesOf('/api/v1/search_shared_skills', lines({ length: 10 * POLICY.bodyLimit }), ' '.repeat(POLICY.bodyLimit + 1)));
        // A kilobyte every 50 ms: far under the byte bound, so only the time bound can close it.
        const drip = setInterval(() => sock.destroyed || sock.write(Buffer.alloc(1024, 0x20)), 50);
      });
      expect([r.status, r.closed]).toEqual([200, true]);
      expect(Date.now() - t0).toBeLessThan(2_500);
    } finally {
      await s.stop();
    }
  });

  it('a sender that never stops past the limit: answered too_large, closed within 2 s, what it sent after the answer discarded, not held', async () => {
    const { s, port, lines } = await session();
    try {
      const chunk = Buffer.alloc(256 * 1024, 0x20);
      let sent = 0;
      // Buffers live outside the JS heap: what's held is the heap plus array buffers and external memory, read after a
      // collection so garbage (the discarded bytes) isn't counted as held.
      const held = () => {
        collect();
        const m = process.memoryUsage();
        return m.heapUsed + m.arrayBuffers + m.external;
      };
      const heldBefore = held();
      const r = await new Promise<Raw & { ms: number }>((resolve) => {
        const t0 = Date.now();
        const got: Buffer[] = [];
        const sock = connect({ host: '127.0.0.1', port });
        const finish = (closed: boolean) => {
          clearTimeout(timer);
          const text = Buffer.concat(got).toString('utf8');
          resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1] ?? 0), head: '', body: '', closed, ms: Date.now() - t0 });
          sock.destroy();
        };
        const timer = setTimeout(() => finish(false), 4_000);
        sock.on('data', (c: Buffer) => got.push(c));
        sock.on('close', () => finish(true));
        sock.on('error', () => undefined);
        // A Content-Length it never reaches, so the request never completes (a completed one node:http closes itself,
        // which would hide the bounds); the 40x cap only keeps a broken server from making this test send forever.
        sock.write(bytesOf('/api/v1/search_shared_skills', lines({ length: 1_000_000_000_000 })));
        // Keeps sending, a chunk at a time (never more than the socket takes), until the server closes.
        const pump = () => {
          while (!sock.destroyed && sent < 40 * POLICY.bodyLimit) {
            sent += chunk.length;
            if (!sock.write(chunk)) return void sock.once('drain', pump);
          }
        };
        pump();
      });
      expect([r.status, r.closed], `closed after ${r.ms} ms`).toEqual([200, true]);
      // Twice the limit discarded closes it long before the one-second bound would.
      expect(r.ms, 'closed by the byte bound').toBeLessThan(600);
      expect(sent, 'it sent past the limit').toBeGreaterThan(POLICY.bodyLimit);
      // A buffer's memory is freed a moment after the collection that finds it unused: collect, wait, then measure.
      await new Promise((r) => setTimeout(r, 100));
      collect();
      await new Promise((r) => setImmediate(r));
      const m = process.memoryUsage();
      expect(held() - heldBefore, `the server held what it discarded (heap ${m.heapUsed} ab ${m.arrayBuffers} ext ${m.external})`).toBeLessThan(POLICY.bodyLimit);
    } finally {
      await s.stop();
    }
  });

  it('a wrong token with a Content-Length of a gigabyte and no body: 401, the connection closed within 2 s', async () => {
    const { s, port, lines } = await session();
    try {
      const r = await raw(port, bytesOf('/api/v1/search_shared_skills', lines({ token: ['wrong'], length: 1_000_000_000 })));
      expect([r.status, r.closed]).toEqual([401, true]);
      expect(r.head).toContain('connection: close');
    } finally {
      await s.stop();
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
