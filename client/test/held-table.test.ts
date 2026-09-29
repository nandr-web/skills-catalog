// The held-update table (golden/policy.yaml `cases`, contract §5.3): the rows for an install over an installed skill and
// for a copy from another catalog, run as they are through the installer. Each row starts from v1 installed in the user
// target; v2 raises exactly the row's flags against it. A row marked `pending` runs as skipped, never as passed.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Surface, actAs } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { contextFor, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { readLock } from '../src/machine/lock.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Surface.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const update = MACHINE_RUNS['update_installed_skills']!;
const policy = MACHINE_RUNS['set_skill_update_policy']!;
const accept = MACHINE_RUNS['accept_held_update']!;

type Row = {
  policy: string;
  override: string;
  flags: string[];
  install_over?: boolean;
  catalog?: 'other';
  older?: boolean;
  newer?: boolean;
  intact?: boolean;
  accept: boolean;
  outcome: string;
  pending?: string;
  note?: string;
};
const rows = (loadGolden('policy.yaml').cases as Row[]).map((c, i) => [i, c] as const).filter(([, c]) => c.install_over || c.catalog === 'other');

const NAME = 'table-skill';
type File = { path: string; text: string; mode?: string };
const manifest = (extra = '', body = 'Follow notes.md.\n') => `---\nname: ${NAME}\ndescription: A skill for the held-update table.\n${extra}---\n${body}`;
const v1: File[] = [{ path: 'SKILL.md', text: manifest() }, { path: 'notes.md', text: 'Step one.\n' }];
// v2: a markdown-only change, plus what raises each flag kind against v1 and nothing else.
const RAISES: Record<string, (files: File[]) => File[]> = {
  runnable_file: (f) => [...f, { path: 'scripts/run.sh', text: '#!/bin/sh\necho run\n', mode: '0755' }],
  non_markdown: (f) => [...f, { path: 'data.json', text: '{}\n' }],
  capability_frontmatter: (f) => f.map((x) => (x.path === 'SKILL.md' ? { ...x, text: manifest('hooks:\n  Stop:\n    - hooks:\n        - type: command\n          command: echo done\n') } : x)),
};
const v2For = (flags: string[]): File[] => flags.reduce((f, k) => RAISES[k]!(f), [v1[0]!, { path: 'notes.md', text: 'Step one.\nStep two.\n' }]);
const unsupported = (r: Row) => r.flags.filter((k) => !RAISES[k]);

const ctxFor = (p: Place): Context => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project')), S, 'mcp').ctx;
const dest = (p: Place) => join(p.osHome, '.claude', 'skills', NAME);

async function publish(p: Place, files: File[]): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(NAME, files), actAs('ana'));
  } finally {
    c.close();
  }
}

describe('the held-update table: installs over an installed skill, and copies from another catalog (golden policy.yaml)', () => {
  for (const [i, row] of rows) {
    const title = `cases[${i}]: ${JSON.stringify({ ...row, note: undefined })}${row.note ? ` (${row.note})` : ''}`;
    (row.pending ? it.skip : it)(title, async () => {
      expect(unsupported(row), 'a flag kind this table has no fixture for: mark the row pending, or add its fixture').toEqual([]);
      const p = place();
      const ctx = ctxFor(p);
      // v1, and v2 raising the row's flags; `older` installs v2 and asks for v1 (a v2 -> v1 diff raising no flags).
      await publish(p, v1);
      await publish(p, row.older ? v2For([]) : v2For(row.flags));
      const installed = row.older ? 2 : 1;
      expect((await install(ctx, { name: NAME, version: installed })).outcome).toBe('installed');
      writeFileSync(join(p.home, 'config.json'), JSON.stringify({ update_policy: row.policy, ...(row.accept ? { accept_flagged_updates: true } : {}) }) + '\n');
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
