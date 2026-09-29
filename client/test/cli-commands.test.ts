// The rest of the CLI face (contract §2, §3): search, read, versions, diff and policy, beside install, list and update.
// Each command runs the registry's operation and prints the core's own rendering of its result, so the CLI says what the
// assistant's tools say, in the CLI's words (a command where a tool would be named). The oracle for each is the core's
// renderer on the same call made directly. (preview and publish follow the registry's split: their own test file.)
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CatalogError, renderDiff, renderError, renderRead, renderSearch, renderVersions, type Catalog } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { COMMANDS, flagsFor } from '../src/cli/run.ts';
import { cli, fixedTokens, lastLogLine, S, TOKEN } from './cli-io.ts';
import { open, seed } from './seed.ts';
import { place, type Place } from './server.ts';

async function withCatalog<T>(p: Place, f: (c: Catalog) => Promise<T>): Promise<T> {
  const c = await open(p);
  try {
    return await f(c);
  } finally {
    c.close();
  }
}

describe('search', () => {
  it('takes its words as the query and prints what the assistant\'s tool would, in the CLI\'s words', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['search', 'release', 'notes']);
    expect([r.code, r.err]).toEqual([0, '']);
    const expected = await withCatalog(p, async (c) => renderSearch(S, await c.search({ query: 'release notes' }), { query: 'release notes' }));
    expect(r.out.trimEnd()).toBe(expected);
    expect(r.out).toContain('skills-catalog read <name>');
    expect(await lastLogLine(p)).toEqual(['-', 'search', S.doc.log.result.search.all, S.format(S.doc.log.search_target, { count: 1, total: 14 })]);
  });

  it('with no words lists the catalog; --tags (comma-separated), --publisher, --limit and --cursor are its filters and paging', async () => {
    const p = place();
    await seed(p);
    const all = await cli(p, ['search', '--limit', '5']);
    expect(all.code).toBe(0);
    const first = await withCatalog(p, (c) => c.search({ limit: 5 }));
    expect(all.out.trimEnd()).toBe(renderSearch(S, first, { limit: 5 }));
    const next = await cli(p, ['search', '--limit', '5', '--cursor', first.next_cursor!]);
    const second = await withCatalog(p, (c) => c.search({ limit: 5, cursor: first.next_cursor! }));
    expect(next.out.trimEnd()).toBe(renderSearch(S, second, { limit: 5, cursor: first.next_cursor! }));
    const byAna = await cli(p, ['search', '--publisher', 'ana']);
    expect(byAna.out).toContain('release-notes-kit');
    expect(byAna.out).not.toContain('sql-migration-helper');
    const tagged = await cli(p, ['search', '--tags', 'no-such-tag,other']);
    const none = await withCatalog(p, (c) => c.search({ filters: { tags: ['no-such-tag', 'other'] } }));
    expect(tagged.out.trimEnd()).toBe(renderSearch(S, none, { filters: { tags: ['no-such-tag', 'other'] } }));
  });

  it('a limit past the most is refused, never clamped (exit 1, on stderr)', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['search', 'notes', '--limit', '51']);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).toContain('invalid_request');
  });
});

describe('read', () => {
  it('reads one skill as the assistant\'s tool would; --version reads an older one', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['read', 'release-notes-kit']);
    expect([r.code, r.err]).toEqual([0, '']);
    const latest = await withCatalog(p, async (c) => renderRead(S, await c.read({ name: 'release-notes-kit' }), TOKEN));
    expect(fixedTokens(r.out.trimEnd())).toBe(latest);
    const old = await cli(p, ['read', 'release-notes-kit', '--version', '1']);
    const v1 = await withCatalog(p, async (c) => renderRead(S, await c.read({ name: 'release-notes-kit', version: 1 }), TOKEN));
    expect(fixedTokens(old.out.trimEnd())).toBe(v1);
    expect(await lastLogLine(p)).toEqual(['-', 'read', S.doc.log.result.get, 'release-notes-kit v1']);
  });

  it('several names read together; --files lists the files, --contents shows them, --path picks some', async () => {
    const p = place();
    await seed(p);
    const both = await cli(p, ['read', 'release-notes-kit', 'sql-migration-helper']);
    expect(fixedTokens(both.out.trimEnd())).toBe(await withCatalog(p, async (c) => renderRead(S, await c.read({ names: ['release-notes-kit', 'sql-migration-helper'] }), TOKEN)));
    for (const [flag, include] of [['--files', 'files'], ['--contents', 'contents']] as const) {
      const r = await cli(p, ['read', 'release-notes-kit', flag]);
      expect(fixedTokens(r.out.trimEnd()), flag).toBe(await withCatalog(p, async (c) => renderRead(S, await c.read({ name: 'release-notes-kit', include }), TOKEN)));
    }
    const one = await cli(p, ['read', 'release-notes-kit', '--path', 'scripts/collect.sh']);
    expect(fixedTokens(one.out.trimEnd())).toBe(await withCatalog(p, async (c) => renderRead(S, await c.read({ name: 'release-notes-kit', paths: ['scripts/collect.sh'] }), TOKEN)));
    expect(one.out).toContain('echo collecting');
  });

  it('--files with --contents (or another --include) contradicts: refused (exit 1); a name not in the catalog says so, with names spelled like it', async () => {
    const p = place();
    await seed(p);
    for (const flags of [['--files', '--contents'], ['--include', 'manifest', '--files']]) {
      const both = await cli(p, ['read', 'release-notes-kit', ...flags]);
      expect(both.code, flags.join(' ')).toBe(1);
      expect(both.err.trimEnd()).toBe(renderError(S, new CatalogError('invalid_request', { field: 'include', why: 'contradicting_flags' })));
    }
    const same = await cli(p, ['read', 'release-notes-kit', '--include', 'files', '--files']);
    expect(same.code).toBe(0);
    const missing = await cli(p, ['read', 'release-notes-kti']);
    expect(missing.out + missing.err).toContain('not_found');
    expect(missing.out + missing.err).toContain('release-notes-kit');
  });
});

describe('the read commands never write (contract §6)', () => {
  const READS = [['search', 'notes'], ['read', 'x'], ['versions', 'x'], ['diff', 'x', '--from', '1', '--to', '2']];

  // A mistyped path is never mistaken for an empty catalog.
  it('pointed at a named folder with no catalog: not a catalog (exit 1), and nothing is created', async () => {
    const p = place();
    const elsewhere = join(p.dir, 'not-a-catalog');
    for (const argv of READS) {
      const r = await cli(p, argv, { env: { SKILLS_CATALOG: pathToFileURL(elsewhere).href } });
      expect([r.code, r.out], argv[0]).toEqual([1, '']);
      expect(r.err, argv[0]).toBe(renderError(S, new CatalogError('invalid_request', { field: 'catalog', why: 'not_a_catalog', path: elsewhere })) + '\n');
      expect(existsSync(elsewhere), argv[0]).toBe(false);
    }
  });

  // Nothing published on this machine yet: the same answers an empty catalog gives, and no catalog is made for them.
  it('with no catalog at the default place yet, they answer as an empty catalog, and create nothing', async () => {
    const p = place(), empty = place();
    (await open(empty)).close();   // a catalog that exists and holds nothing
    const byDefault = { env: { SKILLS_CATALOG: '' } };
    for (const argv of READS) {
      const r = await cli(p, argv, byDefault);
      const same = await cli(empty, argv);
      expect([r.code, r.out, r.err], argv[0]).toEqual([same.code, same.out, same.err]);
    }
    expect(existsSync(join(p.home, 'catalog'))).toBe(false);
  });

  it('list creates no catalog either, named or not', async () => {
    const p = place();
    const elsewhere = join(p.dir, 'not-a-catalog');
    await cli(p, ['list'], { env: { SKILLS_CATALOG: pathToFileURL(elsewhere).href } });
    await cli(p, ['list'], { env: { SKILLS_CATALOG: '' } });
    expect([existsSync(elsewhere), existsSync(join(p.home, 'catalog'))]).toEqual([false, false]);
  });
});

describe('versions and diff', () => {
  it('versions lists a skill\'s history, newest first', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['versions', 'release-notes-kit']);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.trimEnd()).toBe(await withCatalog(p, async (c) => renderVersions(S, await c.versions({ name: 'release-notes-kit' }))));
    const missing = await cli(p, ['versions', 'no-such-skill']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('not_found');
  });

  it('diff takes --from and --to, and shows what changed, the publisher\'s lines inside the fence', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2']);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(fixedTokens(r.out.trimEnd())).toBe(await withCatalog(p, async (c) => renderDiff(S, await c.diff({ name: 'release-notes-kit', from: 1, to: 2 }), TOKEN)));
    expect(await lastLogLine(p)).toEqual(['-', 'diff', S.doc.log.result.diff.runnable, 'release-notes-kit v1 → v2']);
    const noTo = await cli(p, ['diff', 'release-notes-kit', '--from', '1']);
    expect(noTo.code).toBe(1);
    expect(noTo.err).toContain('invalid_request');
  });

  // Paths shown outside the fence are JSON-quoted strings (contract §5.2).
  it('a diff shows each changed path JSON-quoted outside the fence', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2']);
    const outside = r.out.split('\nLine by line:')[0]!;
    expect(outside).toContain('added: "scripts/collect.sh"');
  });
});

describe('policy', () => {
  it('sets the default, or one installed skill\'s; a skill not installed here is refused', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    const all = await cli(p, ['policy', 'notify']);
    expect([all.code, all.err]).toEqual([0, '']);
    expect(all.out.trimEnd()).toBe(S.format(S.word('policy_set.default'), { policy: S.word('policy_name.notify') }));
    const one = await cli(p, ['policy', 'pin', 'sql-migration-helper']);
    expect(one.out.trimEnd()).toBe(S.format(S.word('policy_set.skill'), { name: 'sql-migration-helper', policy: S.word('policy_name.pin') }));
    const list = await cli(p, ['list']);
    expect(list.out).toContain(S.word('policy_name.pin'));
    const notHere = await cli(p, ['policy', 'pin', 'release-notes-kit']);
    expect(notHere.code).toBe(1);
    expect(notHere.err).toContain('not_installed');
    const bogus = await cli(p, ['policy', 'sometimes']);
    expect(bogus.code).toBe(1);
    expect(bogus.err).toContain('invalid_request');
  });
});

describe('install', () => {
  it('--project installs into this repository, as the companion skill says', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['install', 'sql-migration-helper', '--project']);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out).toContain(join(p.dir, 'project', '.claude', 'skills', 'sql-migration-helper'));
    const both = await cli(p, ['install', 'demo-skill-01', '--project', '--target', 'user']);
    expect(both.code).toBe(1);
    expect(both.err.trimEnd()).toBe(renderError(S, new CatalogError('invalid_request', { field: 'target', why: 'contradicting_flags' })));
    expect(both.err).toContain(S.word('errors.why.contradicting_flags'));
  });
});

describe('update --accept on the command line', () => {
  it('with no terminal, gives the person the command as they\'d type it: --as left out wherever it sits, the name quoted when it needs to be', async () => {
    const p = place();
    await seed(p);
    const cases: [string[], string][] = [
      [['update', '--as', 'dev2', 'release-notes-kit', '--accept'], 'skills-catalog update release-notes-kit --accept'],
      [['update', '--as=dev2', 'release-notes-kit', '--accept'], 'skills-catalog update release-notes-kit --accept'],
      [['update', 'x y;z', '--accept', '--as=dev2'], "skills-catalog update 'x y;z' --accept"],
      [['update', "it's", '--accept'], "skills-catalog update 'it'\\''s' --accept"],
    ];
    for (const [argv, command] of cases) {
      const r = await cli(p, argv);
      expect([r.code, r.out], argv.join(' ')).toEqual([3, '']);
      expect(r.err.split('\n')[0], argv.join(' ')).toBe(S.format(S.word('errors.person_only'), { command }));
    }
  });

  it('the command it gives never carries a control character into the person\'s terminal: each is shown escaped', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['update', 'bad\u001b[2Jname\u0007', '--accept']);
    expect(r.code).toBe(3);
    expect(r.err).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
    expect(r.err).toContain("skills-catalog update 'bad\\u{1b}[2Jname\\u{7}' --accept");
  });

  it('takes exactly one skill: two names are a usage mistake before anything else, so no command that can\'t work is given', async () => {
    const p = place();
    await seed(p);
    for (const tty of [false, true]) {
      const r = await cli(p, ['update', 'release-notes-kit', 'sql-migration-helper', '--accept'], { tty, answers: ['y'] });
      expect([r.code, r.out, r.asked], String(tty)).toEqual([1, '', []]);
      expect(r.err).not.toContain(S.format(S.word('errors.person_only'), { command: '' }).trim());
    }
  });
});

// Every command a CLI word names is one the CLI serves, with the flags it names: an assistant that runs what the words
// say never meets "unknown command". Commands still to come are listed, and the test trips when one is served.
const NOT_SERVED_YET = ['preview', 'publish', 'setup', 'teardown', 'login'];
// Where a word uses the product's name as the subject of a sentence ("skills-catalog hit a bug"), not as a command. Kept
// by hand on purpose: any other word after the name is taken as a command, so a mistyped command can't pass as prose.
const PROSE = ['hit', 'won', 'never', 'forget'];
// A flag a word names in an older form than the CLI takes (contract §1: a list is one comma-separated --<field>).
const FLAG_WORD_GAPS: { at: string; command: string; flag: string }[] = [];
// Words still shaped for the assistant's tools (a tool's inputs, "with name ... and paths") where the CLI shows them:
// until their _cli sibling lands in the agent-facing words, and the test trips the moment one does, so it gets wired.
export const CLI_WORD_GAPS = ['publish.preview', 'errors.invalid_confirm'];

// Every string under `node`, with its path.
function strings(node: unknown, path: string[] = []): [string, string][] {
  if (typeof node === 'string') return [[path.join('.'), node]];
  if (!node || typeof node !== 'object') return [];
  return Object.entries(node).flatMap(([k, v]) => strings(v, [...path, k]));
}
// A word as the CLI shows it; `marked` puts ⟦ before each command (a ${cli} or ${op} in the word, never prose that
// happens to say the product's name).
const filled = (t: string, marked = false) =>
  t.replace(/\$\{(\w+)\}/g, (m, k: string) => (marked ? '⟦' : '') + (k === 'cli' ? S.cli : (S.names[k] ?? m)));

// The commands a line names, each with the flags after it (up to the next command on that line).
function commandsIn(raw: string): { command: string; flags: string[] }[] {
  const found: { command: string; flags: string[] }[] = [];
  for (const line of filled(raw, true).split('\n')) {
    const parts = line.split(`⟦${S.cli} `).slice(1);
    for (const part of parts) found.push({ command: /^[a-z]+/.exec(part)![0], flags: [...part.matchAll(/(?<![\w-])--([a-z][a-z-]*)/g)].map((m) => m[1]!) });
  }
  return found;
}

describe('the words and the commands', () => {
  const raw = [...strings(S.doc.results, []), ...strings(S.doc.companion_skill?.cli, ['companion_skill']), ...strings(S.doc.setup, ['setup'])];
  const words = raw.map(([k, t]) => [k, filled(t)] as const);

  it('every command and flag a CLI word names is served', () => {
    const named = raw.flatMap(([k, t]) => commandsIn(t).map((c) => ({ ...c, at: k })));
    expect(named.length).toBeGreaterThan(10);
    const gap = (at: string, command: string, flag: string) => FLAG_WORD_GAPS.some((g) => at.startsWith(g.at) && g.command === command && g.flag === flag);
    for (const { command, flags, at } of named) {
      if (NOT_SERVED_YET.includes(command) || PROSE.includes(command)) continue;
      expect(Object.keys(COMMANDS), `${at} names ${command}`).toContain(command);
      for (const f of flags) if (!gap(at, command, f)) expect(flagsFor(command), `${at}: ${command} --${f}`).toContain(f);
    }
    // Each listed gap is still in the words (this trips when the word is fixed: take it off the list).
    for (const g of FLAG_WORD_GAPS) expect(named.some((n) => n.at.startsWith(g.at) && n.command === g.command && n.flags.includes(g.flag)), `${g.command} --${g.flag}`).toBe(true);
  });

  it('the commands still to come are not served yet (this trips when one is: take it off the list)', () => {
    for (const c of NOT_SERVED_YET) expect(Object.keys(COMMANDS)).not.toContain(c);
  });

  it('no CLI word outside the listed gaps is shaped for the tools; each gap is still open', () => {
    // A command followed by a tool's inputs ("skills-catalog read <name> with name ..."), or a tool's paging.
    const shaped = (t: string) => (t.includes(`${S.cli} `) && /\bwith (name|folder|from and to|paths|cursor|just the folder)\b/.test(t)) || /call again with cursor/.test(t);
    const open = words.filter(([, t]) => shaped(t)).map(([k]) => k);
    expect(open.filter((k) => !CLI_WORD_GAPS.includes(k))).toEqual([]);
    const raw = S.doc.results as Record<string, any>;
    for (const gap of CLI_WORD_GAPS) {
      const [head, ...rest] = gap.split('.');
      const parent = rest.slice(0, -1).reduce((o, k) => o?.[k], raw[head!]);
      expect(parent?.[`${rest.at(-1)}_cli`], `${gap}_cli has landed: wire it and take it off the list`).toBeUndefined();
    }
  });
});
