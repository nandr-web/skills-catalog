// An install over a skill already installed, and a lock entry from another catalog (contract §3, §5.3; the owner's
// decision): the installer table's rows in golden/histories.yaml that have an installed copy and an install, or a copy
// from another catalog, run as they are. Nothing here fills in or changes an expected value.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, Surface, actAs } from '@skills-catalog/core';
import { fingerprint, sha256Hex, type RiskFlag } from '@skills-catalog/core/skill-tree';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { contextFor, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { readLock } from '../src/machine/lock.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Surface.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const update = MACHINE_RUNS['update_installed_skills']!;
const accept = MACHINE_RUNS['accept_held_update']!;
const policy = MACHINE_RUNS['set_skill_update_policy']!;

const histories = loadGolden('histories.yaml');
const table = histories.histories.installer;
const NAME: string = table.name;

type Files = Record<string, string>;
type Row = {
  installed: { version: number; files: string; policy?: string; catalog?: 'other'; lock_planted?: boolean };
  plant: { version: number; files: string }[];
  ask_version?: number;
  damage?: { remove: string };
  setup?: Record<string, unknown>;
  install?: Expect;
  update?: Expect;
  lock_unchanged?: boolean;
  installed_unchanged?: boolean;
  installed_equals?: string;
  lock?: { version?: number; accepted?: 'unchanged'; catalog?: string };
  then_accept?: { send?: Record<string, unknown>; flags: string[]; expect: AcceptExpect };
  note?: string;
};
type Expect = {
  held?: 'pin' | 'notify' | 'flagged' | 'other_catalog';
  target?: string;
  version?: number;
  from?: number;
  risk_flags?: RiskFlag[];
  was?: string;
  now?: string;
  installed?: { version: number };
  unchanged?: { version: number };
};
type AcceptExpect = { installed_equals?: string; lock?: { version?: number; catalog?: string }; policy_after?: string; error?: string; lock_unchanged?: boolean; installed_unchanged?: boolean };

// The rows this file runs: an install over an installed copy, or a copy from another catalog.
const rows = (table.cases as Row[]).map((c, i) => [i, c] as const).filter(([, c]) => typeof c.installed === 'object' && (c.install !== undefined || c.installed.catalog === 'other'));

function ctxFor(p: Place): Context {
  return contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project')), S, 'mcp').ctx;
}
const filesOf = (key: string): Files => histories.versions[key] as Files;
const dest = (p: Place) => join(p.osHome, '.claude', 'skills', NAME);
const lockFile = (p: Place) => join(p.home, 'lock.json');
const tree = (dir: string, rel = ''): Files => {
  const out: Files = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, tree(dir, r));
    else out[r] = readFileSync(join(dir, r), 'utf8');
  }
  return out;
};
const heldOf = (text: string) => {
  const m = /target "([^"]+)", version (\d+), confirm "([^"]+)" and flags (\[[^\]]*\])/.exec(text);
  return m ? { target: m[1]!, version: Number(m[2]), confirm: m[3]!, flags: JSON.parse(m[4]!) as string[] } : undefined;
};
const kinds = (flags: RiskFlag[]) => [...new Set(flags.map((f) => f.kind))];

async function plant(p: Place, versions: Row['plant']): Promise<void> {
  const c = await open(p);
  try {
    for (const v of [...versions].sort((a, b) => a.version - b.version)) {
      await c.publish(request(NAME, Object.entries(filesOf(v.files)).map(([path, text]) => ({ path, text }))), actAs('ana'));
    }
  } finally {
    c.close();
  }
}

describe('an install over an installed skill, and a skill from another catalog (golden histories.installer)', () => {
  for (const [i, row] of rows) {
    it(`installer[${i}]: ${row.note ?? JSON.stringify(row.install ?? row.update)}`, async () => {
      const p = place();
      const ctx = ctxFor(p);
      // The versions the catalog holds, and the installed copy at its version.
      await plant(p, row.plant);
      const first = await install(ctx, { name: NAME, version: row.installed.version });
      expect(first.outcome).toBe('installed');
      // `lock_planted`: the copy as it was installed elsewhere, its files recorded in the lock by their fingerprint, even
      // where this catalog holds other files under the same version.
      if (row.installed.lock_planted) {
        const files = filesOf(row.installed.files);
        rmSync(dest(p), { recursive: true });
        for (const [path, text] of Object.entries(files)) {
          mkdirSync(dirname(join(dest(p), path)), { recursive: true });
          writeFileSync(join(dest(p), path), text, { mode: 0o644 });
        }
        const lock = JSON.parse(readFileSync(lockFile(p), 'utf8'));
        lock.skills[dest(p)].fingerprint = fingerprint(Object.entries(files).map(([path, text]) => ({ path, mode: '0644' as const, sha256: sha256Hex(Buffer.from(text)) })));
        writeFileSync(lockFile(p), JSON.stringify(lock, null, 2) + '\n');
      }
      expect(tree(dest(p))).toEqual(filesOf(row.installed.files));
      if (row.installed.policy) await policy(ctx, { name: NAME, policy: row.installed.policy });
      const CATALOG = readLock(p.home).skills[dest(p)]!.catalog;
      const OTHER = CATALOG.replace(/[^/]+\/?$/, 'other-catalog');
      if (row.installed.catalog === 'other') {
        const lock = JSON.parse(readFileSync(lockFile(p), 'utf8'));
        lock.skills[dest(p)].catalog = OTHER;
        writeFileSync(lockFile(p), JSON.stringify(lock, null, 2) + '\n');
      }
      const vars = (v: string | undefined) => v?.replace('$OTHER_CATALOG', OTHER).replace('$CATALOG', CATALOG);
      if (row.damage) rmSync(join(dest(p), row.damage.remove));
      if (row.setup) writeFileSync(join(p.home, 'config.json'), JSON.stringify(row.setup) + '\n');
      const lockBefore = readFileSync(lockFile(p), 'utf8');
      const treeBefore = tree(dest(p));
      const acceptedBefore = readLock(p.home).skills[dest(p)]!.accepted;

      const e = (row.install ?? row.update)!;
      const r = row.install ? await install(ctx, { name: NAME, ...(row.ask_version === undefined ? {} : { version: row.ask_version }) }) : await update(ctx, {});
      const held = heldOf(r.text);
      if (e.held) {
        const key = e.held === 'flagged' ? 'held' : `held_${e.held}`;
        expect(r.result).toBe(S.doc.log.result[row.install ? 'install' : 'update'][row.install ? key : e.held === 'flagged' ? 'held_flagged' : key]);
        expect(held, 'the held result gives target, version and confirm').toBeDefined();
        if (e.target !== undefined) expect(held!.target).toBe(e.target);
        if (e.version !== undefined) expect(held!.version).toBe(e.version);
        if (e.risk_flags !== undefined) expect(held!.flags).toEqual(kinds(e.risk_flags));
        // With no flags the sentence is exact; with flags it also says why (the golden's flags carry no wording).
        if (row.install && e.held !== 'flagged' && e.risk_flags?.length === 0) {
          const at = { name: NAME, target: held!.target, version: held!.version, from: e.from, confirm: held!.confirm, flags: '[]', also: '', was: vars(e.was), now: vars(e.now) };
          expect(r.text).toBe(S.format(S.word(`install.${key}`), at));
        }
        if (e.risk_flags?.length) expect(r.text).toContain(S.word('update.held_also').split('{reasons}')[0]);
        // The installed version is named: a flagged install over an installed copy has its own sentence for that.
        const word = row.install ? S.word(`install.${e.held === 'flagged' ? 'held_over' : key}`) : S.word(`update.${e.held === 'flagged' ? 'held_flagged' : key}`);
        if (row.install) expect(r.text.startsWith(word.split('{')[0]!)).toBe(true);
        if (row.install) expect(r.text.startsWith(S.format(word.split(/\{(?!name\}|version\})/)[0]!, { name: NAME, version: held!.version }))).toBe(true);
        // `from` is data in every held result; the sentence names it where it has a place for it.
        if (e.from !== undefined && word.includes('{from}')) expect(r.text).toContain(`${NAME} v${e.from}`);
        if (e.held !== 'other_catalog') expect(word).toContain('{from}');
        if (e.was !== undefined) expect([r.text.includes(vars(e.was)!), r.text.includes(vars(e.now)!)]).toEqual([true, true]);
      }
      if (e.installed) {
        expect(r.outcome).toBe('installed');
        expect(readLock(p.home).skills[dest(p)]!.version).toBe(e.installed.version);
      }
      if (e.unchanged) {
        if (row.install) expect([r.outcome, r.text]).toEqual(['unchanged', S.format(S.word('install.unchanged'), { name: NAME, version: e.unchanged.version })]);
        else expect([r.outcome, r.text.split('\n')]).toEqual(['unchanged', expect.arrayContaining([S.format(S.word('update.unchanged'), { n: 1 })])]);
      }
      if (row.lock_unchanged) expect(readFileSync(lockFile(p), 'utf8')).toBe(lockBefore);
      if (row.installed_unchanged) expect(tree(dest(p))).toEqual(treeBefore);
      if (row.installed_equals) expect(tree(dest(p))).toEqual(filesOf(row.installed_equals));
      if (row.lock?.version !== undefined) expect(readLock(p.home).skills[dest(p)]!.version).toBe(row.lock.version);
      if (row.lock?.accepted === 'unchanged') expect(readLock(p.home).skills[dest(p)]!.accepted).toEqual(acceptedBefore);

      const t = row.then_accept;
      if (!t) return;
      const lockHeld = readFileSync(lockFile(p), 'utf8');
      const treeHeld = tree(dest(p));
      const a = await accept(ctx, { name: NAME, target: held!.target, version: held!.version, confirm: held!.confirm, flags: t.flags, ...t.send }).catch((x: unknown) => x);
      const x = t.expect;
      if (x.error) expect((a as CatalogError).code).toBe(x.error);
      else expect((a as { outcome?: string }).outcome).toBe('updated');
      if (x.lock_unchanged) expect(readFileSync(lockFile(p), 'utf8')).toBe(lockHeld);
      if (x.installed_unchanged) expect(tree(dest(p))).toEqual(treeHeld);
      if (x.installed_equals) expect(tree(dest(p))).toEqual(filesOf(x.installed_equals));
      const entry = readLock(p.home).skills[dest(p)]!;
      if (x.lock?.version !== undefined) expect(entry.version).toBe(x.lock.version);
      if (x.lock?.catalog !== undefined) expect(entry.catalog).toBe(vars(x.lock.catalog));
      if (x.policy_after !== undefined) expect(entry.policy).toBe(x.policy_after);
    });
  }

  it('runs the rows it is about', () => {
    expect(rows.map(([i]) => i).length).toBeGreaterThanOrEqual(10);
    expect(existsSync(join(import.meta.dirname, '..', '..', 'qa', 'golden', 'histories.yaml')) && statSync(join(import.meta.dirname, '..', '..', 'qa', 'golden', 'histories.yaml')).isFile()).toBe(true);
  });
});
