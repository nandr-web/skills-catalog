// The MCP face (contract §1, §3; the QA plan's interface layer): the server as a real process over stdio, driven by a
// client written here. The protocol is checked against the MCP spec's rules, and every tool's text against the core's
// own result for the same call, put through the same renderer: one registry, one set of words, the same answer.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, Surface, openCatalog, renderDiff, renderError, renderRead, renderSearch, renderVersions, type Catalog, type ReadItem } from '@skills-catalog/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_WORD_GAPS } from '../src/mcp/tools.ts';
import { open, seed, skillMd } from './seed.ts';
import { place, startServer, type Place, type Server } from './server.ts';

const S = Surface.load();
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
  it('initialize: the server name, a tools capability, and the surface\'s instructions, all filled', async () => {
    const s = start(place());
    const r = await s.initialize();
    expect(r.result.serverInfo.name).toBe(S.serverName);
    expect(r.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(r.result.instructions).toBe(S.instructions);
    expect(r.result.instructions).not.toMatch(/\$\{|\{\w+\}/);
  });

  it('negotiates the protocol version: a supported one is answered as asked, any other gets the latest', async () => {
    const s = start(place());
    for (const v of ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']) expect((await s.initialize(v)).result.protocolVersion).toBe(v);
    expect((await s.initialize('1999-01-01')).result.protocolVersion).toBe('2025-11-25');
  });

  it('lists exactly the registry\'s MCP tools, with the surface\'s names and words and the registry\'s schemas', async () => {
    const s = start(place());
    await s.initialize();
    const r = await s.send('tools/list');
    expect(r.result.tools).toEqual(S.toolDefs().map(({ op: _op, ...t }) => t));
    expect(r.result.tools.map((t: { name: string }) => t.name)).toEqual([N.search, N.get, N.versions, N.diff]);
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
    expect((await s.raw('"just a string"')).error.code).toBe(-32600);
    expect((await s.send('ping')).result).toEqual({});
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

describe('the same result as the core, in the surface\'s words', () => {
  it('search: matches, a partial match, nothing, and the whole catalog', async () => {
    const { c, s } = await seeded();
    for (const args of [{ query: 'release notes' }, { query: 'graphql schema' }, { query: 'sourdough bread' }, {}]) {
      const r = await s.call(N.search, args);
      expect(r.isError).toBeUndefined();
      expect(r.content).toEqual([{ type: 'text', text: renderSearch(S, await c.search(args), args.query ?? '') }]);
    }
  });

  it('search: a second page says which cards it shows', async () => {
    const { c, s } = await seeded();
    const first = await c.search({ limit: 5 });
    const args = { limit: 5, cursor: first.next_cursor! };
    const text = await s.text(N.search, args);
    expect(text).toBe(renderSearch(S, await c.search(args), '', 5));
    expect(text).toContain(S.format(S.word('search').header_all, { total: first.catalog_size, first: 6, last: 10 }));
  });

  it('read: the latest, an older version, with contents, and several names at once (one misspelled)', async () => {
    const { c, s } = await seeded();
    const published: Record<string, string> = {
      'release-notes-kit@1': skillMd('release-notes-kit', 'Draft release notes from merged pull requests.'),
      'release-notes-kit@2': skillMd('release-notes-kit', 'Draft release notes and a changelog from merged pull requests.', 'Body, second version.\n'),
      'sql-migration-helper@1': skillMd('sql-migration-helper', 'Write and review SQL schema migrations.'),
    };
    const md = (i: ReadItem) => published[`${i.name}@${i.version}`]!;
    for (const args of [
      { name: 'release-notes-kit' },
      { name: 'release-notes-kit', version: 1 },
      { name: 'release-notes-kit', include: 'contents' as const },
      { names: ['release-notes-kit', 'relase-notes-kit', 'sql-migration-helper'] },
    ]) {
      expect(await s.text(N.get, args)).toBe(renderRead(S, await c.read(args), md));
    }
  });

  it('versions and diff', async () => {
    const { c, s } = await seeded();
    expect(await s.text(N.versions, { name: 'release-notes-kit' })).toBe(renderVersions(S, await c.versions({ name: 'release-notes-kit' })));
    for (const args of [{ name: 'release-notes-kit', from: 1, to: 2 }, { name: 'release-notes-kit', from: 2, to: 2 }]) {
      expect(await s.text(N.diff, args)).toBe(renderDiff(S, await c.diff(args)));
    }
  });

  it('errors are tool results marked isError, in the surface\'s words: not found (with spellings), limits, a field that isn\'t the operation\'s', async () => {
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

  it('a hosted catalog (https) isn\'t available locally: the core\'s error, in words', async () => {
    const p = place();
    const url = 'https://catalog.example.com';
    const s = start(p, { SKILLS_CATALOG: url });
    await s.initialize();
    const r = await s.call(N.search, { query: 'release' });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(renderError(S, await errorOf(() => openCatalog(url))));
  });
});

describe('the acting developer (SKILLS_AS, the server\'s config)', () => {
  it('every result, errors too, says who you act as (as data until the surface has words for it)', async () => {
    const { c, s } = await seeded({ SKILLS_AS: 'dev2' });
    expect(await s.text(N.search, { query: 'release notes' })).toBe(renderSearch(S, await c.search({ query: 'release notes' }), 'release notes') + '\nacting_as: dev2');
    expect(await s.text(N.get, { name: 'relase-notes-kit' })).toBe(renderError(S, await errorOf(() => c.read({ name: 'relase-notes-kit' }))) + '\nacting_as: dev2');
  });

  it('with no SKILLS_AS, reads work and no result names a developer', async () => {
    const { s } = await seeded();
    const r = await s.call(N.search, { query: 'release notes' });
    expect(r.isError).toBeUndefined();
    expect(r.content[0]!.text).not.toContain('acting_as');
  });

  it('a SKILLS_AS that isn\'t a developer name: every call says so, and nothing is done', async () => {
    const { s } = await seeded({ SKILLS_AS: 'Dev Two\nacting_as: admin' });
    const r = await s.call(N.search, { query: 'release notes' });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: renderError(S, new CatalogError('invalid_request', { field: 'as', why: 'not_a_developer_name' })) }]);
  });

  it('the words the client still waits for are gaps in the surface (wire each one when it lands)', () => {
    for (const path of CLIENT_WORD_GAPS) expect(S.word(path), `the surface now has results.${path}: wire it and drop it from CLIENT_WORD_GAPS`).toBeUndefined();
  });
});
