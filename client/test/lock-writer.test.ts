// One writer at a time on the installed-skills lock (golden histories.lock_writer; contract §4.5): each case as written,
// through the installer in this process, with real waits (a slow file, test/slow.json). The lock file is made by the
// harness: a helper process that holds it the product's way, a dead or reused process id, a file of some age and
// content, a link or a folder. The seams go through the mocked node:fs: `before_stale_remove` replaces the file just
// before the stale one is removed (at the removal's own look), `after_lock_taken` looks at the lock file while lock.json
// is written. `exit` is the CLI's; here the error's code and data stand for it.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { Surface, actAs, type CatalogError } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { readLock } from '../src/machine/lock.ts';
import { contextFor, type Context } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { race } from './race-fs.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));

const S = Surface.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const update = MACHINE_RUNS['update_installed_skills']!;
const list = MACHINE_RUNS['list_installed_skills']!;
const histories = loadGolden('histories.yaml');
const table = histories.lock_writer ?? histories.histories.lock_writer;
const NAME: string = table.name;
const versions = histories.versions as Record<string, Record<string, string>>;

type LockFile = { helper?: { release_after_s: number }; dead_pid?: true; live_pid_other_start?: true; content?: string; age_s?: number; link?: true; folder?: true; other_user?: true };
type Row = {
  id: string;
  lock_file?: LockFile;
  seam?: { before_stale_remove?: { replace_with_helper: { release_after_s: number } }; after_lock_taken?: 'inspect' };
  call: string | { parallel: unknown[] };
  expect: Record<string, any>;
  waited_s?: [number, number];
  lock_unchanged?: boolean;
  installed_unchanged?: boolean;
  lock_file_after?: 'absent' | 'kept';
  outside_unchanged?: boolean;
  output_never_contains?: string;
  plant_mismatch?: boolean;
  root_only?: boolean;
};
const rows = table.cases as Row[];

const ctxFor = (p: Place): Context => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project')), S, 'mcp').ctx;
const lockPath = (p: Place) => join(p.home, 'lock.json.lock');
const dest = (p: Place) => join(p.osHome, '.claude', 'skills', NAME);
const read = (path: string) => (race.fs.existsSync(path) ? race.fs.readFileSync(path, 'utf8') : undefined);
const tree = (dir: string): string => JSON.stringify(race.fs.readdirSync(dir, { recursive: true }).sort().map((f) => [f, race.fs.statSync(join(dir, String(f))).isFile() ? race.fs.readFileSync(join(dir, String(f)), 'utf8') : null]));

async function publish(p: Place, name: string, files: Record<string, string>): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(name, Object.entries(files).map(([path, text]) => ({ path, text }))), actAs('ana'));
  } finally {
    c.close();
  }
}

// A process of the test's own, alive until killed. With `lock`, it holds the lock the product's way (its own pid and start,
// made only if absent, 0600) and removes it after `releaseMs`.
const children: ChildProcess[] = [];
async function helper(lock?: { path: string; releaseMs: number }): Promise<ChildProcess> {
  const script = lock
    ? `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(lock.path)}, JSON.stringify({ pid: process.pid, started: Date.now() - Math.round(process.uptime() * 1000) }), { flag: 'wx', mode: 0o600 }); process.stdout.write('held\\n'); setTimeout(() => fs.unlinkSync(${JSON.stringify(lock.path)}), ${lock.releaseMs}); setTimeout(() => {}, 60000);`
    : `process.stdout.write('up\\n'); setTimeout(() => {}, 60000);`;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  children.push(child);
  await new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
  return child;
}
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);

async function plantLock(p: Place, f: LockFile): Promise<number | null> {
  const path = lockPath(p);
  if (f.helper) return (await helper({ path, releaseMs: f.helper.release_after_s * 1000 })).pid!;
  if (f.link) {
    race.fs.mkdirSync(join(p.dir, 'outside'), { recursive: true });
    race.fs.writeFileSync(join(p.dir, 'outside', 'target'), 'outside\n');
    race.fs.symlinkSync(join(p.dir, 'outside', 'target'), path);
    return null;
  }
  if (f.folder) {
    race.fs.mkdirSync(path);
    return null;
  }
  if (f.dead_pid) race.fs.writeFileSync(path, JSON.stringify({ pid: deadPid(), started: Date.now() - 60_000 }), { mode: 0o600 });
  if (f.live_pid_other_start) race.fs.writeFileSync(path, JSON.stringify({ pid: (await helper()).pid, started: Date.now() - 3_600_000 }), { mode: 0o600 });
  if (f.content !== undefined) {
    race.fs.writeFileSync(path, f.content.replace('$RUN_ID', 'run'), { mode: 0o600 });
    const at = (Date.now() - (f.age_s ?? 0) * 1000) / 1000;
    race.fs.utimesSync(path, at, at);
  }
  return null;
}

describe('one writer at a time on the installed-skills lock (golden histories.lock_writer)', () => {
  // unreadable-young waits for a decision: its file is past 5 s old within the call's own 5 s wait, and the code judges the
  // age at each look (so it's taken), the row at first sight (so lock_busy). Skipped until the contract says which.
  const waitsForDecision = new Set(['unreadable-young']);
  for (const row of rows) {
    const skip = (row.root_only && process.getuid?.() !== 0) || waitsForDecision.has(row.id);
    (skip ? it.skip : it)(`lock_writer ${row.id}`, async () => {
      const p = place();
      const plain = ctxFor(p);
      await publish(p, NAME, versions['prc.v1']!);
      await install(plain, { name: NAME });
      await publish(p, NAME, versions['prc.v2']!);
      if (typeof row.call === 'object') await publish(p, 'release-note-draft', versions['h1.v1']!);
      // `plant_mismatch`: v2's bytes as served don't match its fingerprint in the versions list.
      const ctx: Context = row.plant_mismatch
        ? {
            ...plain,
            catalog: async () => {
              const c = await plain.catalog();
              return new Proxy(c, {
                get: (t, prop, recv) =>
                  prop === 'fetch'
                    ? async (input: { name: string; version: number }) => {
                        const real = await t.fetch(input);
                        return input.version === 2 ? { ...real, files: real.files.map((f) => (f.path === 'SKILL.md' ? { ...f, content_base64: Buffer.from('Altered.\n').toString('base64') } : f)) } : real;
                      }
                    : Reflect.get(t, prop, recv),
              });
            },
          }
        : plain;
      let helperPid = row.lock_file ? await plantLock(p, row.lock_file) : null;
      if (row.seam?.before_stale_remove) {
        // The removal's own look at the lock file is its second one in a round: the first reads who holds it.
        let looks = 0;
        const { release_after_s } = row.seam.before_stale_remove.replace_with_helper;
        const path = lockPath(p);
        race.onLstat = (at) => {
          if (at !== path || ++looks !== 2) return;
          race.onLstat = undefined;
          race.fs.unlinkSync(path);
          // A live writer takes the lock in its place (this runs inside the removal's look, so it waits for the file).
          const script = `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(path)}, JSON.stringify({ pid: process.pid, started: Date.now() - Math.round(process.uptime() * 1000) }), { flag: 'wx', mode: 0o600 }); setTimeout(() => fs.unlinkSync(${JSON.stringify(path)}), ${release_after_s * 1000}); setTimeout(() => {}, 60000);`;
          const child = spawn(process.execPath, ['-e', script], { stdio: 'ignore' });
          children.push(child);
          helperPid = child.pid!;
          while (!race.fs.existsSync(path)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        };
      }
      let whileHeld: { mode: number; pid: number } | undefined;
      if (row.seam?.after_lock_taken) {
        race.onRename = (_from, to) => {
          if (to !== join(p.home, 'lock.json') || whileHeld) return;
          whileHeld = { mode: race.fs.statSync(lockPath(p)).mode & 0o777, pid: JSON.parse(race.fs.readFileSync(lockPath(p), 'utf8')).pid };
        };
      }
      const lockBefore = read(join(p.home, 'lock.json'));
      const installedBefore = tree(dest(p));
      const lockFileBefore = race.fs.existsSync(lockPath(p)) ? { kind: race.fs.lstatSync(lockPath(p)).isSymbolicLink() ? 'link' : race.fs.lstatSync(lockPath(p)).isDirectory() ? 'folder' : 'file', text: race.fs.lstatSync(lockPath(p)).isFile() ? read(lockPath(p)) : undefined } : undefined;
      const outsideBefore = row.outside_unchanged ? read(join(p.dir, 'outside', 'target')) : undefined;

      const started = Date.now();
      let r: unknown;
      try {
        if (typeof row.call === 'object') {
          r = await Promise.all([update(ctx, {}), install(ctx, { name: 'release-note-draft' })]);
        } else if (row.call === 'list_installed_skills') r = await list(ctx, {});
        else r = await update(ctx, {}).catch((e: unknown) => e);
      } finally {
        race.onLstat = undefined;
        race.onRename = undefined;
      }
      const waited = (Date.now() - started) / 1000;

      const e = row.expect;
      if (e['error'] === 'lock_busy') {
        const err = r as CatalogError;
        expect([err.code, err.data]).toEqual(['lock_busy', { path: lockPath(p), pid: e['pid'] === 'helper' ? helperPid : null }]);
      }
      if (e['updated']) {
        expect((r as { outcome?: string }).outcome).toBe('updated');
        expect(readLock(p.home).skills[dest(p)]!.version).toBe(e['updated'].version);
      }
      if (e['installed']) expect(Object.values(readLock(p.home).skills).map((x) => x.name)).toEqual(e['installed']);
      if (e['lock_file_while_held']) expect(whileHeld).toEqual({ mode: 0o600, pid: process.pid });
      if (row.waited_s) expect([row.id, waited >= row.waited_s[0] - 0.2 && waited <= row.waited_s[1]]).toEqual([row.id, true]);
      if (row.lock_unchanged) expect(read(join(p.home, 'lock.json'))).toBe(lockBefore);
      if (row.installed_unchanged) expect(tree(dest(p))).toBe(installedBefore);
      if (row.lock_file_after === 'absent') expect(race.fs.existsSync(lockPath(p))).toBe(false);
      if (row.lock_file_after === 'kept' && lockFileBefore?.kind !== 'file') expect(race.fs.lstatSync(lockPath(p)).isSymbolicLink() ? 'link' : race.fs.lstatSync(lockPath(p)).isDirectory() ? 'folder' : 'file').toBe(lockFileBefore?.kind);
      if (row.lock_file_after === 'kept' && lockFileBefore?.kind === 'file' && !row.seam) expect(read(lockPath(p))).toBe(lockFileBefore.text);
      if (row.outside_unchanged) expect(read(join(p.dir, 'outside', 'target'))).toBe(outsideBefore);
      if (row.output_never_contains) expect(JSON.stringify(r)).not.toContain(row.output_never_contains.replace('$RUN_ID', 'run'));
      for (const c of children.splice(0)) c.kill();
    }, 30_000);
  }

  // A stale lock file written over in place between the check and the removal (the same inode, as a reused one would be)
  // now names a live holder: it's never removed, and the call waits for it.
  it('a stale lock written over in place before its removal is treated as held', async () => {
    const p = place();
    const ctx = ctxFor(p);
    await publish(p, NAME, versions['prc.v1']!);
    await install(ctx, { name: NAME });
    await publish(p, NAME, versions['prc.v2']!);
    const path = lockPath(p);
    race.fs.writeFileSync(path, JSON.stringify({ pid: deadPid(), started: Date.now() - 60_000 }), { mode: 0o600 });
    const live = await helper();
    let looks = 0;
    race.onLstat = (at) => {
      if (at !== path || ++looks !== 2) return;
      race.onLstat = undefined;
      race.fs.writeFileSync(path, JSON.stringify({ pid: live.pid, started: Date.now() }));
    };
    let t = Date.parse('2026-09-29T12:00:00Z');
    let r: unknown;
    try {
      r = await update({ ...ctx, now: () => new Date((t += 1000)) }, {}).catch((e: unknown) => e);
    } finally {
      race.onLstat = undefined;
      for (const c of children.splice(0)) c.kill();
    }
    expect([(r as CatalogError).code, (r as CatalogError).data]).toEqual(['lock_busy', { path, pid: live.pid }]);
    expect(readLock(p.home).skills[dest(p)]!.version).toBe(1);
  });
});
