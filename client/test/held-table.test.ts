// The held-update table (golden/policy.yaml `cases`, contract §5.3): the rows for an install over an installed skill and
// for a copy from another catalog, run as they are through the installer. Each row starts from v1 installed in the user
// target; v2 raises exactly the row's flags against it. A row marked `pending` runs as skipped, never as passed.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Words, actAs } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { cliWords } from '../src/cli/words.ts';
import { contextFor, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { pendingHold } from '../src/machine/installer.ts';
import { readLock } from '../src/machine/lock.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Words.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const update = MACHINE_RUNS['update_installed_skills']!;
const policy = MACHINE_RUNS['set_skill_update_policy']!;
const accept = MACHINE_RUNS['accept_held_update']!;

type Row = {
  policy: string;
  override: string;
  flags: string[];
  install_over?: boolean;
  first_install?: boolean;
  catalog?: 'other';
  older?: boolean;
  newer?: boolean;
  intact?: boolean;
  accept: boolean;
  outcome: string;
  pending?: string;
  note?: string;
};
const rows = (loadGolden('policy.yaml').cases as Row[]).map((c, i) => [i, c] as const);

const NAME = 'table-skill';
type File = { path: string; text: string; mode?: string };
const manifest = (extra = '', body = 'Follow notes.md.\n') => `---\nname: ${NAME}\ndescription: A skill for the held-update table.\n${extra}---\n${body}`;
const v1: File[] = [{ path: 'SKILL.md', text: manifest() }, { path: 'notes.md', text: 'Step one.\n' }];
// v2: a markdown-only change, plus what raises each flag kind against v1 and nothing else.
const RAISES: Record<string, (files: File[]) => File[]> = {
  runnable_file: (f) => [...f, { path: 'scripts/run.sh', text: '#!/bin/sh\necho run\n', mode: '0755' }],
  non_markdown: (f) => [...f, { path: 'data.json', text: '{}\n' }],
  // Only the front matter changes: another file changed while the new version grants something is instructions_changed too.
  capability_frontmatter: (f) => f.map((x) => (x.path === 'SKILL.md' ? { ...x, text: manifest('hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo done\n') } : x.path === 'notes.md' ? v1[1]! : x)),
};
const v2For = (flags: string[]): File[] => flags.filter((k) => k !== 'new_publisher').reduce((f, k) => RAISES[k]!(f), [v1[0]!, { path: 'notes.md', text: 'Step one.\nStep two.\n' }]);
// new_publisher: the lock records the installed copy as another developer's, so v2 (ana's) comes from a new publisher.
const publisherOf = (_flags: string[]) => 'ana';
// Flag kinds the gate on this line doesn't raise yet: they come with the rules reviewer's and the risky-flag checks' range,
// and their rows run there. Reported as skipped, never as passed.
const NOT_HERE = ['prompt_injection', 'context_cost', 'runs_at_load', 'instructions_changed'];
const unsupported = (r: Row) => r.flags.filter((k) => !RAISES[k] && k !== 'new_publisher' && !NOT_HERE.includes(k));
const waits = (r: Row) => r.flags.filter((k) => NOT_HERE.includes(k));

const ctxFor = (p: Place): Context => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed }, join(p.dir, 'project')), S, 'mcp').ctx;
const dest = (p: Place) => join(p.osHome, '.claude', 'skills', NAME);

async function publish(p: Place, files: File[], as = 'ana'): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(NAME, files), actAs(as));
  } finally {
    c.close();
  }
}

describe('the held-update table (golden policy.yaml)', () => {
  for (const [i, row] of rows) {
    const later = waits(row);
    const title = `cases[${i}]: ${JSON.stringify({ ...row, note: undefined })}${row.note ? ` (${row.note})` : ''}${later.length ? ` (waits for the gate raising ${later.join(', ')})` : ''}`;
    (row.pending || later.length ? it.skip : it)(title, async () => {
      expect(unsupported(row), 'a flag kind this table has no fixture for: mark the row pending, or add its fixture').toEqual([]);
      const p = place();
      const ctx = ctxFor(p);
      const config = () => writeFileSync(join(p.home, 'config.json'), JSON.stringify({ update_policy: row.policy, ...(row.accept ? { accept_flagged_updates: true } : {}) }) + '\n');
      // A first install from nothing: the version raising the row's flags against no installed copy.
      if (row.first_install) {
        mkdirSync(p.home, { recursive: true, mode: 0o700 });
        config();
        await publish(p, v1);
        await publish(p, v2For(row.flags), publisherOf(row.flags));
        const r = await install(ctx, { name: NAME });
        if (row.outcome === 'installed') expect([r.outcome, readLock(p.home).skills[dest(p)]!.version]).toEqual(['installed', 2]);
        else {
          expect(r.result).toBe(S.doc.log.result.install.held);
          expect(Object.keys(readLock(p.home).skills)).toEqual([]);
        }
        return;
      }
      // v1, and v2 raising the row's flags; `older` installs v2 and asks for v1 (a v2 -> v1 diff raising no flags);
      // an update with `newer: false` finds no newer version.
      await publish(p, v1);
      if (!(row.newer === false && !row.install_over)) await publish(p, row.older ? v2For([]) : v2For(row.flags), row.older ? 'ana' : publisherOf(row.flags));
      const installed = row.older ? 2 : 1;
      expect((await install(ctx, { name: NAME, version: installed })).outcome).toBe('installed');
      config();
      if (row.flags.includes('new_publisher')) {
        const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
        lock.skills[dest(p)].publisher = 'ben';
        writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
      }
      if (row.override !== 'none') await policy(ctx, { name: NAME, policy: row.override });
      if (row.catalog === 'other') {
        const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
        lock.skills[dest(p)].catalog = join(p.dir, 'other-catalog');
        writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
      }
      if (row.intact === false) rmSync(join(dest(p), 'notes.md'));
      const lockBefore = readFileSync(join(p.home, 'lock.json'), 'utf8');

      const asked = row.newer === false ? installed : row.older ? 1 : 2;
      const r = row.install_over ? await install(ctx, { name: NAME, version: asked }) : await update(ctx, {});
      const op = row.install_over ? 'install' : 'update';
      const [what, why] = row.outcome.split(':') as [string, string | undefined];
      if (what === 'held') {
        const key = why === 'flagged' ? (op === 'install' ? 'held' : 'held_flagged') : `held_${why}`;
        expect(r.result).toBe(S.doc.log.result[op][key]);
        // The hold names the flags the person agrees to.
        expect(JSON.parse(/and flags (\[[^\]]*\])/.exec(r.text)?.[1] ?? 'null')).toEqual(row.flags);
        expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);
      } else {
        expect(r.outcome).toBe(what);
        const entry = readLock(p.home).skills[dest(p)]!;
        expect(entry.version).toBe(what === 'unchanged' ? installed : asked);
        // The lock records each update accept_flagged_updates let through (§5.3).
        if (row.accept && what === 'updated' && row.flags.length) expect(entry.accepted).toContainEqual({ version: asked, flags: row.flags, by: 'accept_flagged_updates' });
        if (what === 'unchanged') expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);
        if (what === 'installed') expect(readFileSync(join(dest(p), 'SKILL.md'), 'utf8')).toBe((asked === 1 ? v1 : v2For(row.flags))[0]!.text);
      }
    });
  }

  it('runs the rows it is about', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });
});

// Accepting a held pin, notify or other-catalog update, from an install or an update (golden policy.yaml accept_cases):
// the version is taken, the policy kept (a pinned skill stays pinned, at the new version), the catalog in use recorded.
describe('accepting a hold keeps the policy and records the catalog (golden accept_cases.keeps_policy, other_catalog)', () => {
  const g = loadGolden('policy.yaml').accept_cases;
  const heldOf = (text: string) => {
    const m = /target "([^"]+)", version (\d+), confirm "([^"]+)"/.exec(text);
    return m ? { target: m[1]!, version: Number(m[2]), confirm: m[3]! } : undefined;
  };
  type Keep = { hold: { from: 'install' | 'update'; reason: 'pin' | 'notify'; risk_flags?: string[] }; flags: string[]; lock_version_after?: number; policy_after?: string; outcome?: string; installed_unchanged?: boolean; pending?: string };
  (g.keeps_policy.cases as Keep[]).forEach((c, i) => {
    (c.pending ? it.skip : it)(`keeps_policy[${i}]: ${JSON.stringify(c)}`, async () => {
      const flags = c.hold.risk_flags ?? [];
      expect(flags.filter((k) => !RAISES[k]), 'a flag kind this table has no fixture for: mark the row pending, or add its fixture').toEqual([]);
      const p = place();
      const ctx = ctxFor(p);
      await publish(p, v1);
      await install(ctx, { name: NAME });
      await policy(ctx, { name: NAME, policy: c.hold.reason });
      await publish(p, v2For(flags));
      const r = c.hold.from === 'install' ? await install(ctx, { name: NAME }) : await update(ctx, {});
      const held = heldOf(r.text)!;
      const lockHeld = readFileSync(join(p.home, 'lock.json'), 'utf8');
      const a = await accept(ctx, { name: NAME, ...held, flags: c.flags }).catch((e: unknown) => e);
      if (c.outcome === 'conflict') {
        expect((a as { code?: string }).code).toBe('conflict');
        if (c.installed_unchanged) expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockHeld);
        return;
      }
      const entry = readLock(p.home).skills[dest(p)]!;
      expect([entry.version, entry.policy]).toEqual([c.lock_version_after, c.policy_after]);
    });
  });
  type Other = { flags: string[]; lock_version_after: number; lock_catalog_after: 'now'; policy_after: 'unchanged' };
  (g.other_catalog.cases as Other[]).forEach((c, i) => {
    it(`other_catalog[${i}]: ${JSON.stringify(c)}`, async () => {
      const p = place();
      const ctx = ctxFor(p);
      await publish(p, v1);
      await install(ctx, { name: NAME });
      const now = readLock(p.home).skills[dest(p)]!.catalog;
      const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
      lock.skills[dest(p)].catalog = join(p.dir, 'other-catalog');
      writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
      await publish(p, v2For(c.flags));
      const before = readLock(p.home).skills[dest(p)]!;
      const r = await update(ctx, {});
      expect(r.result).toBe(S.doc.log.result.update.held_other_catalog);
      await accept(ctx, { name: NAME, ...heldOf(r.text)!, flags: c.flags });
      const entry = readLock(p.home).skills[dest(p)]!;
      expect([entry.version, entry.catalog, entry.policy]).toEqual([c.lock_version_after, now, before.policy]);
    });
  });
});

// The same version number from another catalog is another catalog's skill, not the installed one: installing it over the
// copy from the catalog it came from is held as other_catalog, whether its files differ or not, and nothing changes.
// On the CLI a hold's words are the CLI's: the command the person runs to take it, never the assistant's tool.
describe('a hold over an installed copy, at the CLI', () => {
  const words = cliWords(S);
  const cliCtx = (p: Place): Context => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed }, join(p.dir, 'project')), words, 'cli').ctx;
  for (const reason of ['pin', 'notify', 'other_catalog'] as const) {
    it(`held_${reason} names the command to run, not the tool`, async () => {
      const p = place();
      const ctx = cliCtx(p);
      await publish(p, v1);
      await install(ctx, { name: NAME });
      if (reason !== 'other_catalog') await policy(ctx, { name: NAME, policy: reason });
      else {
        const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
        lock.skills[dest(p)].catalog = join(p.dir, 'other-catalog');
        writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
      }
      await publish(p, v2For([]));
      const r = await install(ctx, { name: NAME });
      expect(r.result).toBe(S.doc.log.result.install[`held_${reason}`]);
      expect(r.text.startsWith(words.word('install')[`held_${reason}`].split('{')[0])).toBe(true);
      expect(r.text).toContain(`${S.cli} update ${NAME} --accept`);
      expect(r.text).not.toContain(S.names['accept' as keyof typeof S.names] as string);
    });
  }
});

describe('the same version from another catalog', () => {
  for (const files of ['different', 'the same'] as const) {
    it(`is held as other_catalog when its files are ${files}, and the installed copy and the lock stay as they are`, async () => {
      const p = place();
      const ctx = ctxFor(p);
      await publish(p, v1);
      await install(ctx, { name: NAME });
      const other = join(p.dir, 'other-catalog');
      const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
      lock.skills[dest(p)].catalog = other;
      writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
      const lockBefore = readFileSync(join(p.home, 'lock.json'), 'utf8');
      // "different": the installed copy is v1 as the other catalog had it (its files and fingerprint differ from this v1).
      if (files === 'different') writeFileSync(join(dest(p), 'notes.md'), 'Step one, as the other catalog had it.\n');
      const installedNotes = readFileSync(join(dest(p), 'notes.md'), 'utf8');
      if (files === 'different') {
        const l = JSON.parse(lockBefore);
        l.skills[dest(p)].fingerprint = 'sha256:' + '0'.repeat(64);
        writeFileSync(join(p.home, 'lock.json'), JSON.stringify(l, null, 2) + '\n');
      }
      const lockHeld = readFileSync(join(p.home, 'lock.json'), 'utf8');
      const r = await install(ctx, { name: NAME, version: 1 });
      expect([files, r.result]).toEqual([files, S.doc.log.result.install.held_other_catalog]);
      expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockHeld);
      expect(readFileSync(join(dest(p), 'notes.md'), 'utf8')).toBe(installedNotes);
      // It waits for the person as the CLI's update <name> --accept finds it, and their yes takes it, recording the catalog
      // in use.
      expect(await pendingHold(ctx, NAME)).toEqual(expect.objectContaining({ reason: 'other_catalog', installed: 1, version: 1 }));
      const m = /target "([^"]+)", version (\d+), confirm "([^"]+)"/.exec(r.text)!;
      await accept(ctx, { name: NAME, target: m[1], version: Number(m[2]), confirm: m[3], flags: [] });
      expect([readLock(p.home).skills[dest(p)]!.catalog, readFileSync(join(dest(p), 'notes.md'), 'utf8')]).toEqual([p.catalogUrl, v1[1]!.text]);
    });
  }
});

// What the CLI's update <name> --accept shows comes from pendingHold: why the hold waits (§5.3's order), and for a copy
// from another catalog, where it came from and where this version comes from.
describe('the hold waiting for the person says why', () => {
  it('pin, notify, another catalog or the flags, in that order, with the flags it lists', async () => {
    const cases: { setup: 'pin' | 'notify' | 'other' | 'none'; flags: string[]; reason: string }[] = [
      { setup: 'pin', flags: [], reason: 'pin' },
      { setup: 'pin', flags: ['runnable_file'], reason: 'pin' },
      { setup: 'notify', flags: [], reason: 'notify' },
      { setup: 'other', flags: ['non_markdown'], reason: 'other_catalog' },
      { setup: 'none', flags: ['runnable_file'], reason: 'flagged' },
    ];
    for (const c of cases) {
      const p = place();
      const ctx = ctxFor(p);
      await publish(p, v1);
      await install(ctx, { name: NAME });
      const now = readLock(p.home).skills[dest(p)]!.catalog;
      const other = join(p.dir, 'other-catalog');
      if (c.setup === 'pin' || c.setup === 'notify') await policy(ctx, { name: NAME, policy: c.setup });
      if (c.setup === 'other') {
        const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
        lock.skills[dest(p)].catalog = other;
        writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
      }
      await publish(p, v2For(c.flags));
      const h = await pendingHold(ctx, NAME);
      expect([c.setup, h]).toEqual([
        c.setup,
        expect.objectContaining({ reason: c.reason, installed: 1, version: 2, target: 'user', flags: c.flags, ...(c.reason === 'other_catalog' ? { was: other, now } : {}) }),
      ]);
    }
  });
});

// The fixtures raise exactly their kinds (so a row's flags are what the installer computes from them).
describe('the table\'s fixtures', () => {
  it('each raises its own kind and nothing else against v1', async () => {
    const { diffTrees } = await import('@skills-catalog/core/skill-tree');
    const tree = (files: File[]) => files.map((f) => ({ path: f.path, mode: (f.mode ?? '0644') as '0644' | '0755', bytes: Buffer.from(f.text) }));
    for (const k of [[], ...Object.keys(RAISES).map((x) => [x])]) {
      const d = diffTrees({ files: tree(v1), publisher: 'ana' }, { files: tree(v2For(k)), publisher: 'ana' });
      expect([k, [...new Set(d.risk_flags.map((f) => f.kind))]]).toEqual([k, k]);
    }
    expect(skillMd).toBeTypeOf('function');
  });
});
