// Folders another user could control (golden histories.private_folders; contract §4.5): each row as written. A folder's
// mode is set with a real chmod inside the sandbox (made first when it isn't there); its owner and group, which only an
// admin could change, are injected through the mocked node:fs. A refusal changes nothing under the assistant's home, the
// project or SKILLS_HOME.
import { join } from 'node:path';
import { actAs } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { readLock } from '../src/machine/lock.ts';
import { race } from './race-fs.ts';
import { clearHooks, codeOf, ctxFor, install, refusalOf, refused, update } from './race.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));

const histories = loadGolden('histories.yaml');
const table = histories.private_folders ?? histories.histories.private_folders;
const NAME: string = table.name;
const versions = histories.versions as Record<string, Record<string, string>>;
const uid = process.getuid!();

type Stat = { path: string; mode: string; gid?: string | number; uid?: string | number };
type Row = {
  id: string;
  target?: 'project';
  stat?: Stat;
  stat_after_install?: Stat;
  pre_existing?: { folder: string };
  installed?: { version: number; files: string };
  plant?: { version: number; files: string }[];
  install?: { error?: string; path?: string; target?: string; home?: true; own?: boolean; installed?: { version: number } };
  update?: { refused: { version: number; error: string; path: string; target: string; own: boolean } };
  nothing_written?: true;
  lock_unchanged?: true;
  installed_unchanged?: true;
};

// The golden's words for an owner or group, as ids.
const idOf = (v: string | number | undefined): number | undefined => {
  if (v === undefined || typeof v === 'number') return v;
  if (v.startsWith("the user's uid")) return uid;
  if (v === 'another user') return uid + 1;
  if (v === 'another group' || v === 'a shared group') return uid + 12_345;
  throw new Error(`no id for ${JSON.stringify(v)}`);
};
const at = (p: Place, path: string) => path.replace('$A', p.osHome).replace('$P', join(p.dir, 'project'));
function applyStat(p: Place, s: Stat): string {
  const path = at(p, s.path);
  race.fs.mkdirSync(path, { recursive: true });
  race.fs.chmodSync(path, parseInt(s.mode, 8));
  const owner = idOf(s.uid);
  const group = idOf(s.gid);
  if (owner !== undefined || group !== undefined) {
    const prev = race.stats;
    race.stats = (where, st) => (where === path ? { ...(owner === undefined ? {} : { uid: owner }), ...(group === undefined ? {} : { gid: group }) } : prev?.(where, st));
  }
  return path;
}
// Every file and folder under the places a refusal must leave alone, with its bytes.
function snapshot(p: Place): string {
  const out: [string, string | null][] = [];
  for (const root of [p.osHome, join(p.dir, 'project'), p.home]) {
    if (!race.fs.existsSync(root)) continue;
    for (const f of race.fs.readdirSync(root, { recursive: true }).map(String).sort()) {
      const full = join(root, f);
      out.push([full, race.fs.lstatSync(full).isFile() ? race.fs.readFileSync(full, 'utf8') : null]);
    }
  }
  return JSON.stringify(out);
}
async function publish(p: Place, files: Record<string, string>): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(NAME, Object.entries(files).map(([path, text]) => ({ path, text }))), actAs('ana'));
  } finally {
    c.close();
  }
}

describe('folders another user could control (golden histories.private_folders)', () => {
  for (const row of table.cases as Row[]) {
    it(`private_folders ${row.id}`, async () => {
      const p = place();
      const ctx = ctxFor(p);
      const target = row.target ?? 'user';
      try {
        if (row.update) {
          for (const v of row.plant!) await publish(p, versions[v.files]!);
          await install(ctx, { name: NAME, version: row.installed!.version });
          applyStat(p, row.stat_after_install!);
          const lockBefore = race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8');
          const dest = join(p.osHome, '.claude', 'skills', NAME);
          const copyBefore = race.fs.readFileSync(join(dest, 'SKILL.md'), 'utf8');
          const r = await update(ctx, {});
          const u = row.update.refused;
          expect([codeOf(r), refusalOf(r).data['path']]).toEqual([u.error, at(p, u.path)]);
          if (row.lock_unchanged) expect(race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);
          if (row.installed_unchanged) expect(race.fs.readFileSync(join(dest, 'SKILL.md'), 'utf8')).toBe(copyBefore);
          return;
        }
        await publish(p, versions['planted.stale-clean']!);
        if (row.pre_existing) race.fs.mkdirSync(at(p, row.pre_existing.folder), { recursive: true });
        if (row.stat) applyStat(p, row.stat);
        const before = snapshot(p);
        const r = await install(ctx, { name: NAME, target }).catch((e: unknown) => e);
        const e = row.install!;
        if (e.error) {
          expect([codeOf(r), refused(r).data]).toEqual([e.error, { path: at(p, e.path!), target: e.target, ...(e.home ? { home: true } : {}), own: e.own }]);
          if (row.nothing_written) {
            expect(snapshot(p)).toBe(before);
            expect(Object.keys(readLock(p.home).skills)).toEqual([]);
          }
        } else {
          expect((r as { outcome?: string }).outcome).toBe('installed');
          expect(readLock(p.home).skills[join(target === 'user' ? p.osHome : join(p.dir, 'project'), '.claude', 'skills', NAME)]!.version).toBe(e.installed!.version);
        }
      } finally {
        clearHooks();
      }
    });
  }

  it('runs every row', () => {
    expect((table.cases as Row[]).length).toBeGreaterThanOrEqual(22);
  });
});
