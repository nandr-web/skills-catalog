// The golden policy.local_files rows (contract §4.5, §9): a damaged lock.json or config.json is refused by every command
// that reads it, naming the file, why and (for config.json) the key, and nothing changes: the damaged file keeps its bytes,
// the installed skill its files, every other file under SKILLS_HOME its bytes, and no output holds the sentinel planted in
// the damaged file. The ok rows aren't damage: the commands work as usual.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, Words, actAs, renderError } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { contextFor, perform, type Context } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

type Damage = { bytes?: string } & Record<string, unknown>;
type Row = { id: string; file?: 'lock.json' | 'config.json'; damage?: Damage; remove?: 'lock.json' | 'config.json'; why?: string; key?: string; expect?: Record<string, unknown> };

const S = Words.load();
const g = loadGolden('policy.yaml').local_files as { commands: string[]; cases: Row[]; ok_cases: Row[] };
const versions = loadGolden('histories.yaml').versions as Record<string, Record<string, string>>;
const NAME = 'pr-review-checklist';
// Commands of guided setup, which isn't built on this line: their rows run when it is.
const NOT_YET: Record<string, string> = { setup: 'guided setup' };

const ctxFor = (p: Place): Context => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed }, join(p.dir, 'project')), S, 'mcp').ctx;
const skillDir = (p: Place) => join(p.osHome, '.claude', 'skills', NAME);

async function publish(p: Place, files: Record<string, string>): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(NAME, Object.entries(files).map(([path, text]) => ({ path, text }))), actAs('ana'));
  } finally {
    c.close();
  }
}

// Every file under a folder, by path, with its bytes (and, where asked, its modification time).
function files(dir: string, mtimes = false): Record<string, string> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => statSync(join(dir, f)).isFile())
      .sort()
      .map((f) => [f, readFileSync(join(dir, f)).toString('base64') + (mtimes ? ` ${statSync(join(dir, f), { bigint: true }).mtimeNs}` : '')]),
  );
}

// `QA-SENTINEL-$RUN_ID` planted in the damage, with this run's id.
const plant = <T>(x: T, sentinel: string): T => JSON.parse(JSON.stringify(x).replaceAll('QA-SENTINEL-$RUN_ID', sentinel)) as T;

// A real install of prc.v1 for the user target and a config of {"update_policy": "auto"}, then the row's damage:
// `bytes` rewrites the file, `entry.<field>` (dotted) changes that field of the lock's one entry, `remove` deletes it.
async function damaged(row: Row, sentinel: string): Promise<{ p: Place; ctx: Context; path?: string; bytes?: string }> {
  const p = place();
  const ctx = ctxFor(p);
  await publish(p, versions['prc.v1']!);
  expect((await perform(ctx, 'install_shared_skill', 'install_shared_skill', { name: NAME })).isError).toBe(false);
  writeFileSync(join(p.home, 'config.json'), JSON.stringify({ update_policy: 'auto' }));
  if (row.remove) {
    rmSync(join(p.home, row.remove));
    return { p, ctx };
  }
  const path = join(p.home, row.file!);
  const d = plant(row.damage!, sentinel);
  if (d.bytes !== undefined) writeFileSync(path, d.bytes);
  else {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as { skills: Record<string, Record<string, unknown>> };
    const entry = lock.skills[skillDir(p)]!;
    for (const [field, value] of Object.entries(d)) {
      const at = field.replace(/^entry\./, '').split('.');
      let o: Record<string, unknown> = entry;
      for (const k of at.slice(0, -1)) o = o[k] as Record<string, unknown>;
      o[at.at(-1)!] = value;
    }
    writeFileSync(path, JSON.stringify(lock));
  }
  return { p, ctx, path, bytes: readFileSync(path, 'utf8') };
}

// Each command with arguments that reach the files: an install of the installed skill, an update of everything, a yes to
// a hold (refused before its token is read), the listing and a skill's policy.
const ARGS: Record<string, Record<string, unknown>> = {
  install_shared_skill: { name: NAME },
  update_installed_skills: {},
  accept_held_update: { name: NAME, target: 'user', version: 1, flags: [], confirm: 'x' },
  list_installed_skills: {},
  set_skill_update_policy: { name: NAME, policy: 'pin' },
};

describe('a damaged lock or config file (golden policy.local_files)', () => {
  it('every command the rows name is one this runner calls, or one not built yet', () => {
    expect(g.commands.filter((c) => !ARGS[c] && !NOT_YET[c])).toEqual([]);
  });

  for (const row of g.cases) {
    it(`local_files ${row.id}`, async () => {
      const sentinel = `QA-SENTINEL-${randomBytes(6).toString('hex')}`;
      const { p, ctx, path, bytes } = await damaged(row, sentinel);
      const skill = files(skillDir(p));
      const home = { ...files(p.home, row.file === 'config.json') };
      const want = { file: row.file, why: row.why, path, ...(row.key !== undefined ? { key: row.key } : {}) };
      for (const command of g.commands.filter((c) => ARGS[c])) {
        const r = await perform(ctx, command, command, ARGS[command]);
        expect([row.id, command, r.isError, r.text]).toEqual([row.id, command, true, renderError(S, new CatalogError('invalid_local_file', want))]);
        expect([row.id, command, r.text.includes(sentinel)]).toEqual([row.id, command, false]);
      }
      expect(readFileSync(path!, 'utf8')).toBe(bytes);
      expect(files(skillDir(p))).toEqual(skill);
      // Every file under SKILLS_HOME as it was, the damaged one included (a refused config.json leaves lock.json's mtime
      // too), less the logs that get a line per call (the activity log and the usage counts); no line holds the sentinel.
      const after = files(p.home, row.file === 'config.json');
      const logs = Object.keys(after).filter((f) => join(p.home, f) === ctx.settings.activityLog || f.startsWith('usage/'));
      for (const f of logs) {
        expect([row.id, f, readFileSync(join(p.home, f), 'utf8').includes(sentinel)]).toEqual([row.id, f, false]);
        delete home[f];
        delete after[f];
      }
      expect(after).toEqual(home);
    });
  }

  for (const row of g.ok_cases) {
    it(`local_files ok ${row.id}`, async () => {
      const { p, ctx } = await damaged(row, 'QA-SENTINEL-ok');
      const e = row.expect!;
      if (e['list_installed_skills']) {
        const r = await perform(ctx, 'list_installed_skills', 'list_installed_skills', {});
        const installed = (e['list_installed_skills'] as { installed: number | [] }).installed;
        expect([row.id, r.isError, r.text.includes(NAME)]).toEqual([row.id, false, Array.isArray(installed) ? installed.length > 0 : true]);
      }
      // The policy in effect, as the listing says it: the same words as an install whose config sets only that policy.
      if (e['update_policy_effective']) {
        const control = await damaged({ id: 'control', file: 'config.json', damage: { bytes: JSON.stringify({ update_policy: e['update_policy_effective'] }) } }, '');
        const want = await perform(control.ctx, 'list_installed_skills', 'list_installed_skills', {});
        const got = await perform(ctx, 'list_installed_skills', 'list_installed_skills', {});
        expect([row.id, got.isError, got.text]).toEqual([row.id, false, want.text]);
      }
    });
  }

  for (const [command, what] of Object.entries(NOT_YET)) it.skip(`local_files through ${command} (waits for ${what})`, () => {});
  it.skip('local_files teardown and the session-start hook (wait for guided setup)', () => {});
});
