// The MCP face (contract §1, §3; the QA plan's interface layer): the server as a real process over stdio, driven by a
// client written here. The protocol is checked against the MCP spec's rules, and every tool's text against the core's
// own result for the same call, put through the same renderer: one API, one set of words, the same answer.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, OPERATIONS, Words, openCatalog, renderDiff, renderError, renderRead, renderSearch, renderVersions, type Catalog } from '@skills-catalog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_LINE } from '../src/mcp/server.ts';
import { CLIENT_WORD_GAPS, RUNS } from '../src/operations.ts';
import { open, seed } from './seed.ts';
import { PROCESS_TEST_MS, place, startServer, type Place, type Server } from './server.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start the server as a process (see PROCESS_TEST_MS)

const S = Words.load();
const N = S.names as Record<'search' | 'get' | 'versions' | 'diff', string>;

const servers: Server[] = [];
const catalogs: Catalog[] = [];
function start(p: Place, env: Record<string, string> = {}): Server {
  const s = startServer(p, env);
  servers.push(s);
  return s;
}
async function seeded(env: Record<string, string> = {}) {
  const p = place();
  await seed(p);
  const c = await open(p);
  catalogs.push(c);
  const s = start(p, env);
  await s.initialize();
  return { p, c, s };
}

afterEach(async () => {
  for (const c of catalogs.splice(0)) c.close();
  for (const s of servers.splice(0)) {
    await s.close();
    // stdout is the protocol: a stray line (a log, a warning) would break the client.
    for (const line of s.lines) expect(() => JSON.parse(line), `a stdout line that isn't JSON-RPC: ${line}`).not.toThrow();
  }
});

/** The fence token in a text, found with the words file's own opening marker (e.g. "--- SKILL.md {token} ---"). */
function tokenIn(text: string, marker: string): string {
  const [before, after] = marker.split('{token}').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const m = new RegExp(`^${before}(\\S+)${after}$`, 'm').exec(text);
  if (!m) throw new Error(`no fence like ${JSON.stringify(marker)} in: ${text.slice(0, 200)}`);
  return m[1]!;
}

async function errorOf(fn: () => Promise<unknown>): Promise<CatalogError> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('expected a CatalogError');
}

describe('the protocol (newline-delimited JSON-RPC 2.0 over stdio)', () => {
  it('initialize: the server name, a tools capability, and the words file\'s instructions, all filled', async () => {
    const s = start(place());
    const r = await s.initialize();
    expect(r.result.serverInfo.name).toBe(S.serverName);
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.instructions).toBe(S.instructions);
    expect(r.result.instructions).not.toMatch(/\$\{|\{\w+\}/);
  });

  it('negotiates the protocol version: a supported one is answered as asked, any other gets the latest', async () => {
    const s = start(place());
    for (const v of ['2024-11-05', '2025-06-18', '2025-11-25']) expect((await s.initialize(v)).result.protocolVersion).toBe(v);
    // 2025-03-26 requires JSON-RPC batches, which this server doesn't take: never offered
    for (const v of ['2025-03-26', '1999-01-01']) expect((await s.initialize(v)).result.protocolVersion).toBe('2025-11-25');
  });

  it('lists the API\'s MCP tools it runs, with the words file\'s names and words and the API\'s schemas: every catalog one, and machine ones as the installer adds them', async () => {
    const s = start(place());
    await s.initialize();
    const r = await s.send('tools/list');
    const defs = S.toolDefs();
    expect(r.result.tools).toEqual(defs.filter((d) => RUNS[d.op]).map(({ op: _op, ...t }) => t));
    for (const name of [N.search, N.get, N.versions, N.diff]) expect(r.result.tools.map((t: { name: string }) => t.name)).toContain(name);
    // What isn't served yet is a machine operation still to come, never a catalog one.
    for (const d of defs.filter((x) => !RUNS[x.op])) expect(OPERATIONS[d.op]!.kind, d.op).toBe('machine');
    expect(r.result.nextCursor).toBeUndefined();
  });

  it('ping answers {}; notifications get no reply; an unknown method is -32601; bad params are -32602', async () => {
    const s = start(place());
    await s.initialize();
    expect((await s.send('ping')).result).toEqual({});
    const before = s.lines.length;
    s.notify('notifications/cancelled', { requestId: 99, reason: 'test' });
    s.notify('notifications/something_new');
    expect((await s.send('ping')).result).toEqual({});
    expect(s.lines.length).toBe(before + 1);
    expect((await s.send('resources/list')).error.code).toBe(-32601);
    expect((await s.send('tools/call')).error.code).toBe(-32602);
    expect((await s.send('tools/call', { name: 7 })).error.code).toBe(-32602);
    expect((await s.send('tools/call', { name: 'no_such_tool', arguments: {} })).error.code).toBe(-32602);
  });

  it('a line that isn\'t JSON is -32700, a batch or a message without jsonrpc 2.0 is -32600, and the server keeps answering', async () => {
    const s = start(place());
    await s.initialize();
    expect((await s.raw('{not json')).error.code).toBe(-32700);
    expect((await s.raw('[{"jsonrpc":"2.0","id":1,"method":"ping"}]')).error.code).toBe(-32600);
    expect((await s.raw('{"id":null,"method":"ping"}')).error.code).toBe(-32600);
    expect(await s.frame({ id: 'no-version', method: 'ping' })).toMatchObject({ id: 'no-version', error: { code: -32600 } });
    expect((await s.raw('{"jsonrpc":"2.0","id":null,"method":"ping"}')).error.code).toBe(-32600);
    expect((await s.raw('"just a string"')).error.code).toBe(-32600);
    expect((await s.send('ping')).result).toEqual({});
  });

  it('a line over the cap is refused (-32600) as soon as it passes the cap, before its end arrives, so it is never held whole; the next message is answered', async () => {
    const s = start(place());
    await s.initialize();
    const huge = '{"jsonrpc":"2.0","id":"huge","method":"ping","params":{"pad":"' + 'x'.repeat(MAX_LINE + 1024) + '"}}';
    const refused = await s.partial(huge);          // no newline yet: the refusal can't wait for one
    expect(refused.error.code).toBe(-32600);
    s.write('\n');                                  // the line's end
    expect((await s.send('ping')).result).toEqual({});
    expect(s.lines.some((l) => l.includes('"huge"'))).toBe(false);
  });

  it('exits 0 when its input closes', async () => {
    const s = startServer(place());
    await s.initialize();
    expect(await s.close()).toBe(0);
  });

  it('answers every call still in flight when its input closes, from an open catalog, then exits 0', async () => {
    const p = place();
    await seed(p);
    const s = startServer(p);
    await s.initialize();
    const calls: [string, unknown][] = [
      [N.search, { query: 'release notes' }],
      [N.get, { name: 'release-notes-kit', include: 'contents' }],
      [N.versions, { name: 'release-notes-kit' }],
      [N.diff, { name: 'release-notes-kit', from: 1, to: 2 }],
    ];
    const pending = Array.from({ length: 20 }, (_, i) => s.call(...calls[i % calls.length]!));
    const exit = s.close();
    for (const r of await Promise.all(pending)) expect(r.isError, r.content[0]?.text).toBeUndefined();
    expect(await exit).toBe(0);
  });
});

describe('what Claude Code sends (its frames, recorded with Claude Code 2.1.284)', () => {
  type Recorded = { dir: 'client_to_server' | 'server_to_client'; frame: Record<string, any> };
  const recorded: Recorded[] = readFileSync(new URL('./fixtures/claude-code-2.1.284-read-tools.jsonl', import.meta.url), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const sent = recorded.filter((r) => r.dir === 'client_to_server').map((r) => r.frame);
  const answer = (id: unknown) => recorded.find((r) => r.dir === 'server_to_client' && r.frame['id'] === id)!.frame;

  it('replayed as sent, each gets the kind of reply it got: server/discover -32601, then initialize, the tool list, a search with _meta', async () => {
    const p = place();
    await seed(p);
    const s = start(p);
    expect(sent.map((f) => f['method'])).toEqual(['server/discover', 'initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const frame of sent) {
      const got = await s.frame(frame);
      if (!('id' in frame)) {
        expect(got, frame['method']).toBeUndefined();
        continue;
      }
      const want = answer(frame['id']);
      expect(got.id).toEqual(frame['id']);
      expect(Object.keys(got).sort(), frame['method']).toEqual(Object.keys(want).sort());
      if (want['error']) expect(got.error.code).toBe(want['error'].code);
    }
  });

  it('the handshake it falls back to: its protocol version, its capabilities, the same tool names', async () => {
    const s = start(place());
    const [, init, , list] = sent;
    await s.frame(sent[0]!);
    const r = await s.frame(init!);
    expect(r.result.protocolVersion).toBe(init!['params'].protocolVersion);
    expect(r.result.capabilities).toEqual(answer(init!['id'])['result'].capabilities);
    const tools = (await s.frame(list!)).result.tools.map((t: { name: string }) => t.name);
    // The tools it was recorded with are all still served; any served since is a machine operation that came later.
    const recorded: string[] = answer(list!['id'])['result'].tools.map((t: { name: string }) => t.name);
    for (const name of recorded) expect(tools).toContain(name);
    const opOf = (name: string) => S.toolDefs().find((d) => d.name === name)!.op;
    for (const name of tools.filter((n: string) => !recorded.includes(n))) expect(OPERATIONS[opOf(name)]!.kind, name).toBe('machine');
  });

  it('a tool call carrying Claude Code\'s _meta (its tool-use id, a progress token) is answered as any other', async () => {
    const { s } = await seeded();
    const call = sent.find((f) => f['method'] === 'tools/call')!;
    expect(call['params']._meta).toBeDefined();
    const r = await s.frame({ ...call, id: 'replayed-call' });
    expect(r.result.isError).toBeUndefined();
    expect(r.result.content[0].text).toMatch(/^Shared catalog: /);
  });
});

describe('the words point only at tools that are served', () => {
  it('every tool the instructions, descriptions and results name is served', async () => {
    const { s } = await seeded();
    const init = await s.initialize();
    const list = (await s.send('tools/list')).result.tools as { name: string; description: string; inputSchema: unknown }[];
    const texts: string[] = [init.result.instructions, ...list.map((t) => t.description + JSON.stringify(t.inputSchema))];
    const calls: [string, unknown][] = [
      [N.search, { query: 'release notes' }],
      [N.search, { query: 'graphql schema' }],
      [N.search, { query: 'sourdough bread' }],
      [N.search, { limit: 5 }],
      [N.search, { limit: 51 }],
      [N.get, { name: 'release-notes-kit', include: 'files' }],
      [N.get, { name: 'relase-notes-kit' }],
      [N.versions, { name: 'release-notes-kit' }],
      [N.diff, { name: 'release-notes-kit', from: 1, to: 2 }],
    ];
    for (const [tool, args] of calls) texts.push(await s.text(tool, args));
    const all = texts.join('\n');
    const named = Object.values(S.names).filter((n) => new RegExp(`\\b${n}\\b`).test(all));
    expect(named.filter((n) => !list.some((t) => t.name === n))).toEqual([]);
  });
});

describe('the same result as the core, in the words file\'s words', () => {
  it('search: matches, a partial match, nothing, and the whole catalog', async () => {
    const { c, s } = await seeded();
    for (const args of [{ query: 'release notes' }, { query: 'graphql schema' }, { query: 'sourdough bread' }, {}]) {
      const r = await s.call(N.search, args);
      expect(r.isError).toBeUndefined();
      expect(r.content).toEqual([{ type: 'text', text: renderSearch(S, await c.search(args), args) }]);
    }
  });

  it('search: a second page says which cards it shows', async () => {
    const { c, s } = await seeded();
    const first = await c.search({ limit: 5 });
    const args = { limit: 5, cursor: first.next_cursor! };
    const text = await s.text(N.search, args);
    expect(text).toBe(renderSearch(S, await c.search(args), args));
    expect(text).toContain(S.format(S.word('search').header_all, { total: first.catalog_size, first: 6, last: 10 }));
  });

  it('read: the latest, an older version, with contents, and several names at once (one misspelled); the fence carries a fresh token each read', async () => {
    const { c, s } = await seeded();
    const tokens: string[] = [];
    for (const args of [
      { name: 'release-notes-kit' },
      { name: 'release-notes-kit', version: 1 },
      { name: 'release-notes-kit', include: 'contents' as const },
      { names: ['release-notes-kit', 'relase-notes-kit', 'sql-migration-helper'] },
    ]) {
      const text = await s.text(N.get, args);
      const token = tokenIn(text, S.word('get').fence[0]);
      tokens.push(token);
      expect(text).toBe(renderRead(S, await c.read(args), { next: () => token }));
    }
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('versions and diff (the changed lines fenced with a token of their own)', async () => {
    const { c, s } = await seeded();
    expect(await s.text(N.versions, { name: 'release-notes-kit' })).toBe(renderVersions(S, await c.versions({ name: 'release-notes-kit' })));
    const changed = await s.text(N.diff, { name: 'release-notes-kit', from: 1, to: 2 });
    const token = tokenIn(changed, S.word('diff').fence[0]);
    expect(changed).toBe(renderDiff(S, await c.diff({ name: 'release-notes-kit', from: 1, to: 2 }), { next: () => token }));
    const none = { next: (): string => { throw new Error('the same content has no lines to fence'); } };
    expect(await s.text(N.diff, { name: 'release-notes-kit', from: 2, to: 2 })).toBe(renderDiff(S, await c.diff({ name: 'release-notes-kit', from: 2, to: 2 }), none));
  });

  it('errors are tool results marked isError, in the words file\'s words: not found (with spellings), limits, a field that isn\'t the operation\'s', async () => {
    const { c, s } = await seeded();
    const ops: Record<string, (a: unknown) => Promise<unknown>> = {
      [N.search]: (a) => c.search(a),
      [N.get]: (a) => c.read(a),
      [N.versions]: (a) => c.versions(a),
      [N.diff]: (a) => c.diff(a),
    };
    const cases: [string, unknown][] = [
      [N.get, { name: 'relase-notes-kit' }],
      [N.search, { limit: 51 }],
      [N.get, { names: Array.from({ length: 21 }, (_, i) => `skill-${i}`) }],
      [N.versions, {}],
      [N.diff, { name: 'release-notes-kit', from: 1, to: 9 }],
      [N.search, { query: 'release', bogus: true }],
      [N.search, undefined],
    ];
    for (const [tool, args] of cases) {
      const r = await s.call(tool, args);
      if (args === undefined) {
        expect(r.isError).toBeUndefined(); // no arguments is an empty request: the whole catalog
        continue;
      }
      expect(r.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(r.content).toEqual([{ type: 'text', text: renderError(S, await errorOf(() => ops[tool]!(args))) }]);
    }
  });
});

describe('when something is wrong', () => {
  it('a bug gives internal_error: a log in SKILLS_HOME/logs, no traceback, and the server keeps answering', async () => {
    const p = place();
    mkdirSync(p.catalogDir, { recursive: true });
    writeFileSync(join(p.catalogDir, 'catalog.sqlite'), 'this is not a database. '.repeat(200));
    const s = start(p);
    await s.initialize();
    for (let i = 0; i < 2; i++) {
      const r = await s.call(N.search, { query: 'release' });
      expect(r.isError).toBe(true);
      const text = r.content[0]!.text;
      const log = /\((?:[^()]*?) (\/[^\s()]+\.log)\)/.exec(text)?.[1];
      expect(log, text).toBeDefined();
      expect(log!.startsWith(join(p.home, 'logs') + '/')).toBe(true);
      expect(text).toBe(renderError(S, new CatalogError('internal_error', { log })));
      expect(text).not.toMatch(/\n\s+at |\.ts:\d+/);
    }
    expect((await s.send('ping')).result).toEqual({});
    // A catalog that couldn't be opened is tried again on the next call: once it's fixed, the tools work.
    rmSync(join(p.catalogDir, 'catalog.sqlite'));
    expect((await s.call(N.search, { query: 'release' })).isError).toBeUndefined();
  });

  it('a hosted catalog (https) that can\'t be reached: an internal error with its log, and the server goes on', async () => {
    const p = place();
    const s = start(p, { SKILLS_CATALOG: 'https://127.0.0.1:1' });
    await s.initialize();
    const r = await s.call(N.search, { query: 'release' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('internal_error');
    expect((await s.call(N.search, { query: 'release' })).isError).toBe(true);
  });
});

describe('the acting developer (SKILLS_AS, the server\'s config)', () => {
  it('every result, errors too, says who you act as (as data until the words file has words for it)', async () => {
    const { c, s } = await seeded({ SKILLS_AS: 'dev2' });
    const line = '\n' + S.format(S.word('acting_as'), { developer: 'dev2' });
    expect(line).toContain('dev2');
    expect(await s.text(N.search, { query: 'release notes' })).toBe(renderSearch(S, await c.search({ query: 'release notes' }), { query: 'release notes' }) + line);
    expect(await s.text(N.get, { name: 'relase-notes-kit' })).toBe(renderError(S, await errorOf(() => c.read({ name: 'relase-notes-kit' }))) + line);
  });

  it('with no SKILLS_AS, reads work and no result names a developer', async () => {
    const { s } = await seeded();
    const r = await s.call(N.search, { query: 'release notes' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).not.toMatch(/acting/i);
  });

  it('a SKILLS_AS that isn\'t a developer name: every call says so (as data until the words file words it; a retry can\'t fix it), and nothing is done', async () => {
    const { s } = await seeded({ SKILLS_AS: 'Dev Two\nacting_as: admin' });
    const r = await s.call(N.search, { query: 'release notes' });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: renderError(S, new CatalogError('invalid_developer_setting', { setting: 'SKILLS_AS' })) }]);
    expect(r.content[0]!.text).toMatch(/SKILLS_AS setting/);
    expect(r.content[0]!.text).not.toContain('admin');
  });

  it('the words the client still waits for are gaps in the words file (wire each one when it lands)', () => {
    const at = (path: string) => path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), S.doc);
    for (const path of CLIENT_WORD_GAPS) expect(at(path), `the words file now has ${path}: wire it and drop it from CLIENT_WORD_GAPS`).toBeUndefined();
  });
});
