// Replacing an installed copy safely (golden histories.replace_safely; contract §4.5): each row as written, through the
// installer, with the golden's seams as hooks of the mocked node:fs: `after_check` at the first rename that touches the
// skill's path (the move aside, or a first install's move in), `after_staging_made` at the look at the staging folder just
// before the temp folder is made, `before_place` right after the move aside, `after_place` right after the new copy goes
// in; `fault: move_back_fails` fails every rename that would put a moved-aside folder back. A row this runner can't run
// is skipped with its reason, never passed.
import { join } from 'node:path';
import { actAs } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { readLock } from '../src/machine/lock.ts';
import { contextFor } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { race } from './race-fs.ts';
import { S, clearHooks, ctxFor, install, refusalOf, refused, unformat, update } from './race.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));

const histories = loadGolden('histories.yaml');
const table = histories.replace_safely ?? histories.histories.replace_safely;
const NAME: string = table.name;
const versions = histories.versions as Record<string, Record<string, string>>;

type Action = { swap_for_link?: { path: string; keep_at: string }; swap_for_folder?: { path: string; keep_at: string }; link?: { path: string; to: string } };
type Row = {
  id: string;
  installed: 'none' | { version: number; files: string };
  target?: 'project';
  plant: { version: number; files: string }[];
  lock_copy?: 'absent' | 'dev_ino_only' | 'other_birth';
  env?: Record<string, string>;
  stat_identity?: { ino: string };
  recreate?: true;
  pre_existing?: { folder?: string; files?: Record<string, string>; link?: string; to?: string };
  seam?: { after_check?: Action; after_staging_made?: Action; before_place?: Action; after_place?: Action };
  fault?: 'move_back_fails';
  install?: Record<string, any>;
  update?: Record<string, any>;
  then?: Record<string, any>;
  old_copy?: 'deleted' | 'kept_in_staging';
  placed_copy?: 'taken_back';
  lock?: { version?: number; copy?: unknown };
  staging_after?: string;
  staging_mode?: string;
  nothing_moved?: true;
  no_lock_entry?: true;
  never_reports_success?: true;
  after_call?: { link_at?: string; pointing_to?: string; in_staging?: string; in?: string; holds?: string; gone?: string };
  lock_unchanged?: true;
  installed_unchanged?: true;
  outside_unchanged?: true;
  pre_existing_unchanged?: true;
  needs?: string;
  stat?: { path: string; mode: string };
  observe?: { seam: string; staging: string };
  no_writes_under?: string;
};

// Rows this runner can't run yet, and why (reported as skipped, never as passed).
const CANT: Record<string, string> = {
  'project-on-another-volume': 'needs a second volume (the QA safety rules: an APFS image or a Docker tmpfs)',
  'recreated-checked-folders-fail': 'its seam fires in the check of an unchanged recreated copy, which makes no rename to hook',
};

type Paths = { A: string; P: string; S: string; ST: string; RUN: string; dest: string };
// With SKILLS_INSTALL_DIR the skills folder is that folder, and staging goes beside it (§8).
const pathsOf = (p: Place, installDir?: string): Paths => {
  const A = p.osHome;
  const S = installDir ?? join(A, '.claude', 'skills');
  return { A, P: join(p.dir, 'project'), S, ST: join(S, '..', '.skills-catalog-staging'), RUN: p.dir, dest: join(S, NAME) };
};
const at = (x: Paths, s: string) => s.replace('$ST', x.ST).replace('$S', x.S).replace('$A', x.A).replace('$P', x.P).replace('$RUN', x.RUN);

// What the harness left under $RUN/outside/, less the installer's own staging folder (it removes its own temp folders
// and an empty staging folder, even in a .claude that was moved there).
const outsideTree = (x: Paths) => tree(join(x.RUN, 'outside'), (rel) => !rel.includes('.skills-catalog-staging'));

// A folder's contents: names, kinds, bytes, link targets and modes (not times); `keep` leaves out paths it says no to.
function tree(dir: string, keep: (rel: string) => boolean = () => true): string {
  if (!race.fs.existsSync(dir) && !isLink(dir)) return 'absent';
  const out: string[] = [];
  const walk = (rel: string) => {
    if (!keep(rel)) return;
    const full = join(dir, rel);
    const st = race.fs.lstatSync(full);
    if (st.isSymbolicLink()) return void out.push(`${rel} -> ${race.fs.readlinkSync(full)}`);
    if (st.isFile()) return void out.push(`${rel} ${(st.mode & 0o777).toString(8)} ${race.fs.readFileSync(full, 'utf8')}`);
    out.push(`${rel}/ ${(st.mode & 0o777).toString(8)}`);
    for (const e of race.fs.readdirSync(full).sort()) walk(rel ? join(rel, e) : e);
  };
  walk('');
  return out.join('\n');
}
function isLink(path: string): boolean {
  try {
    return race.fs.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
const filesIn = (dir: string): Record<string, string> => Object.fromEntries(race.fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => race.fs.statSync(join(dir, f)).isFile()).sort().map((f) => [f, race.fs.readFileSync(join(dir, f), 'utf8')]));

async function publish(p: Place, files: Record<string, string>): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(NAME, Object.entries(files).map(([path, text]) => ({ path, text }))), actAs('ana'));
  } finally {
    c.close();
  }
}

function act(x: Paths, a: Action): void {
  const move = (b: { path: string; keep_at: string }, then: (path: string, keep: string) => void) => {
    const path = at(x, b.path);
    const keep = at(x, b.keep_at);
    race.fs.mkdirSync(join(keep, '..'), { recursive: true });
    race.fs.renameSync(path, keep);
    then(path, keep);
  };
  if (a.swap_for_link) move(a.swap_for_link, (path, keep) => race.fs.symlinkSync(keep, path));
  if (a.swap_for_folder) move(a.swap_for_folder, (path) => race.fs.mkdirSync(path));
  if (a.link) {
    const to = at(x, a.link.to);
    race.fs.mkdirSync(to, { recursive: true });
    race.fs.writeFileSync(join(to, 'canary'), 'keep me\n');
    race.fs.symlinkSync(to, at(x, a.link.path));
  }
}

// What a result says, read back through the words it was made from: the error (thrown, or an update's refused line), the
// versions an update's line names, and where a kept copy was named.
function said(r: unknown): { code?: string; data: Record<string, unknown>; updated?: { from: number; to: number }; installed?: boolean; staging?: string } {
  const { code, data } = refusalOf(r);
  const text = refused(r).text ?? '';
  const out: ReturnType<typeof said> = { code, data };
  for (const line of text.split('\n')) {
    const u = unformat(S.word('update').updated, line);
    if (u) out.updated = { from: Number(u['from']), to: Number(u['to']) };
    const k = unformat(S.word('update').kept_in_staging, line);
    if (k) out.staging = k['staging'];
    if (unformat(S.word('install').done, line)) out.installed = true;
  }
  if (!out.staging && typeof data['staging'] === 'string') out.staging = data['staging'];
  return out;
}

describe('replacing an installed copy safely (golden histories.replace_safely)', () => {
  for (const row of table.cases as Row[]) {
    const why = CANT[row.id];
    (why ? it.skip : it)(`replace_safely ${row.id}${why ? ` (${why})` : ''}`, async () => {
      const p = place();
      // `env`: the row's settings for the call, $RUN being the run's own folder.
      const env = Object.fromEntries(Object.entries(row.env ?? {}).map(([k, v]) => [k, v.replace('$RUN', p.dir)]));
      const x = pathsOf(p, env['SKILLS_INSTALL_DIR']);
      const ctx = row.env
        ? contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed, ...env }, join(p.dir, 'project')), S, 'mcp').ctx
        : ctxFor(p);
      race.fs.mkdirSync(join(x.RUN, 'outside'), { recursive: true });
      // `stat`: the folder's mode, set with a real chmod in the sandbox (made first when it isn't there).
      if (row.stat) {
        race.fs.mkdirSync(at(x, row.stat.path), { recursive: true });
        race.fs.chmodSync(at(x, row.stat.path), parseInt(row.stat.mode, 8));
      }
      // `observe.staging`: the staging folder every move of the row's calls goes through.
      const moves: string[] = [];
      try {
        // The catalog, and the installed copy (a real install of stale-v1 as version 1).
        const [first, ...rest] = [...row.plant].sort((a, b) => a.version - b.version);
        await publish(p, versions[first!.files]!);
        // stat_identity: the core's look at the skill's folder (its temp folder, then wherever it moves) reports that ino.
        if (row.stat_identity) {
          const real = new Set<string>();
          race.stats = (path, s) => {
            const key = `${s.dev}:${s.ino}`;
            if (/\/install-[^/]+$/.test(path) && real.size === 0) real.add(key);
            return real.has(key) ? { ino: BigInt(row.stat_identity!.ino) as unknown as number } : undefined;
          };
        }
        const then = row.then ? [row.then] : [];
        let r: unknown;
        if (row.installed !== 'none') {
          await install(ctx, { name: NAME, version: 1 });
          for (const v of rest) await publish(p, versions[v.files]!);
        } else if (!row.install) {
          for (const v of rest) await publish(p, versions[v.files]!);
        }
        if (row.lock_copy) {
          const lock = JSON.parse(race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8'));
          const e = lock.skills[x.dest];
          if (row.lock_copy === 'absent') delete e.copy;
          if (row.lock_copy === 'dev_ino_only') delete e.copy.birth;
          if (row.lock_copy === 'other_birth') e.copy.birth = Number(e.copy.birth ?? 0) + 1000;
          race.fs.writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
        }
        if (row.recreate) {
          const fresh = `${x.dest}.fresh`;
          race.fs.mkdirSync(fresh);
          for (const [f, text] of Object.entries(filesIn(x.dest))) {
            race.fs.mkdirSync(join(fresh, f, '..'), { recursive: true });
            race.fs.writeFileSync(join(fresh, f), text, { mode: 0o644 });
          }
          const oldIno = race.fs.lstatSync(x.dest).ino;
          race.fs.rmSync(x.dest, { recursive: true });
          race.fs.renameSync(fresh, x.dest);
          race.fs.chmodSync(x.dest, 0o755);
          expect(race.fs.lstatSync(x.dest).ino).not.toBe(oldIno);
        }
        if (row.pre_existing) {
          const pe = row.pre_existing;
          if (pe.folder) {
            race.fs.mkdirSync(at(x, pe.folder), { recursive: true });
            for (const [f, text] of Object.entries(pe.files ?? {})) race.fs.writeFileSync(join(at(x, pe.folder), f), text);
          }
          if (pe.link) {
            const to = at(x, pe.to!);
            race.fs.mkdirSync(to, { recursive: true });
            race.fs.writeFileSync(join(to, 'canary'), 'keep me\n');
            race.fs.mkdirSync(join(at(x, pe.link), '..'), { recursive: true });
            race.fs.symlinkSync(to, at(x, pe.link));
          }
        }
        // A first install takes version 1; with a second call, the versions after it come once the first call is done.
        if (row.installed === 'none' && row.install && !row.then) for (const v of rest) await publish(p, versions[v.files]!);

        const lockBefore = race.fs.existsSync(join(p.home, 'lock.json')) ? race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8') : undefined;
        const installedBefore = tree(x.dest);
        const preBefore = row.pre_existing?.folder ? tree(at(x, row.pre_existing.folder)) : undefined;
        const outsideBefore = () => outsideTree(x);
        let outsideAtCall = outsideBefore();

        // The seams and the fault.
        let renames = 0;
        let looksAtStaging = 0;
        const s = row.seam ?? {};
        const once = { check: false, place: false, before: false };
        race.onRename = (from, to) => {
          if (row.fault === 'move_back_fails' && from.endsWith('-replaced') && to === x.dest) throw Object.assign(new Error('the move back fails (the golden fault)'), { code: 'ENOENT' });
          if (s.after_check && !once.check && (from === x.dest || to === x.dest)) {
            once.check = true;
            act(x, s.after_check);
            outsideAtCall = outsideBefore();
          }
        };
        race.afterRename = (from, to) => {
          // Moves of folders in the assistant's home (the lock file's own rename, in SKILLS_HOME, isn't one).
          if (from.startsWith(x.A) || to.startsWith(x.A)) renames++;
          moves.push(from, to);
          if (s.before_place && !once.before && from === x.dest) {
            once.before = true;
            act(x, s.before_place);
            outsideAtCall = outsideBefore();
          }
          if (s.after_place && !once.place && to === x.dest) {
            once.place = true;
            act(x, s.after_place);
            outsideAtCall = outsideBefore();
          }
        };
        if (s.after_staging_made) {
          race.onLstat = (path) => {
            if (path !== x.ST || ++looksAtStaging !== 3) return;
            act(x, s.after_staging_made!);
            outsideAtCall = outsideBefore();
          };
        }

        const call = row.install ? 'install' : 'update';
        r = row.install ? await install(ctx, { name: NAME }).catch((e: unknown) => e) : await update(ctx, {}).catch((e: unknown) => e);
        race.onRename = undefined;
        race.afterRename = undefined;
        race.onLstat = undefined;
        const got = said(r);
        const e = (row.install ?? row.update)!;

        // The result.
        if (e['installed']) {
          expect([row.id, got.installed]).toEqual([row.id, true]);
          expect(readLock(p.home).skills[x.dest]!.version).toBe(e['installed'].version);
        }
        if (e['updated']) expect([row.id, got.updated]).toEqual([row.id, { from: e['updated'].from, to: e['updated'].to }]);
        if (e['unchanged']) expect((r as { outcome?: string }).outcome).toBe('unchanged');
        const refusal = e['refused'] ?? (e['error'] ? { error: e['error'], path: e['path'] } : undefined);
        if (refusal) {
          expect([row.id, got.code, got.data['path']]).toEqual([row.id, refusal.error, at(x, refusal.path)]);
          if (refusal.temp) expect(got.data['temp']).toBe(true);
          if (refusal.elsewhere) expect(got.data['elsewhere']).toBe(true);
        }
        const staged = e['installed']?.staging ?? e['updated']?.staging ?? refusal?.staging;
        if (staged) expect([row.id, got.staging && join(got.staging, '..')]).toEqual([row.id, x.ST]);
        if (row.never_reports_success) expect([got.installed, got.updated]).toEqual([undefined, undefined]);

        // What's where after the call.
        if (row.old_copy === 'kept_in_staging') expect(filesIn(got.staging!)).toEqual(versions['planted.stale-v1']);
        if (row.old_copy === 'deleted') expect(race.fs.existsSync(x.ST) ? race.fs.readdirSync(x.ST).filter((f) => f !== '.gitignore') : []).toEqual([]);
        if (row.lock?.version !== undefined) expect(readLock(p.home).skills[x.dest]!.version).toBe(row.lock.version);
        if (row.lock?.copy !== undefined) {
          const copy = readLock(p.home).skills[x.dest]!.copy!;
          const st = race.fs.lstatSync(x.dest, { bigint: true });
          const given = typeof row.lock.copy === 'object' ? (row.lock.copy as { ino?: string }).ino : undefined;
          const want = given !== undefined && /^\d+$/.test(given) ? BigInt(given) : st.ino;
          expect([row.id, BigInt(copy.dev), BigInt(copy.ino)]).toEqual([row.id, st.dev, want]);
        }
        if (row.staging_after === 'absent') expect(race.fs.existsSync(x.ST)).toBe(false);
        if (row.staging_after === 'gitignore') expect(race.fs.readFileSync(join(x.ST, '.gitignore'), 'utf8')).toBe('*\n');
        if (row.staging_mode) expect((race.fs.statSync(x.ST).mode & 0o777).toString(8).padStart(4, '0')).toBe(row.staging_mode);
        if (row.nothing_moved) expect(renames).toBe(0);
        if (row.no_lock_entry) expect(race.fs.existsSync(join(p.home, 'lock.json')) ? Object.keys(readLock(p.home).skills) : []).toEqual([]);
        if (row.lock_unchanged) expect(race.fs.existsSync(join(p.home, 'lock.json')) ? race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8') : undefined).toBe(lockBefore);
        if (row.installed_unchanged) expect(tree(x.dest)).toBe(installedBefore);
        if (row.pre_existing_unchanged) expect(tree(at(x, row.pre_existing!.folder!))).toBe(preBefore);
        if (row.outside_unchanged) expect(outsideTree(x)).toBe(outsideAtCall);
        if (row.placed_copy === 'taken_back') expect(race.fs.existsSync(x.dest) ? filesIn(x.dest) : {}).not.toEqual(versions['planted.stale-clean']);
        const a = row.after_call;
        if (a?.link_at) expect(race.fs.readlinkSync(at(x, a.link_at))).toBe(at(x, a.pointing_to!));
        if (a?.in_staging) expect(race.fs.readlinkSync(got.staging!)).toBe(join(x.RUN, 'outside', 'victim'));
        if (a?.in) expect(filesIn(at(x, a.in))).toEqual(versions['planted.stale-clean']);
        if (a?.gone) expect(race.fs.existsSync(at(x, a.gone))).toBe(false);
        void call;

        // A second call, where the row has one.
        if (row.then && row.installed === 'none') for (const v of rest) await publish(p, versions[v.files]!);
        for (const t of then) {
          race.afterRename = (from, to) => void moves.push(from, to);
          const r2 = t['update'] ? await update(ctx, {}) : await install(ctx, { name: NAME });
          race.afterRename = undefined;
          const got2 = said(r2);
          if (t['update']?.updated) expect(got2.updated).toEqual({ from: t['update'].updated.from, to: t['update'].updated.to });
          if (t['old_copy'] === 'deleted') expect(race.fs.existsSync(x.ST)).toBe(false);
        }
        if (row.observe) {
          const staging = at(x, row.observe.staging);
          expect([row.id, moves.some((m) => m.startsWith(`${staging}/`))]).toEqual([row.id, true]);
          expect([row.id, moves.filter((m) => m.includes('.skills-catalog-staging') && !m.startsWith(`${staging}/`))]).toEqual([row.id, []]);
        }
        // A description "absent (<path>)": that path is gone after every call.
        const absent = /^absent \((\$[^)]+)\)$/.exec(row.staging_after ?? '');
        if (absent) expect(race.fs.existsSync(at(x, absent[1]!))).toBe(false);
        if (row.no_writes_under) expect(race.fs.existsSync(at(x, row.no_writes_under))).toBe(false);
      } finally {
        clearHooks();
      }
    });
  }
});
