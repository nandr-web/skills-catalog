// Decisions are taken under the lock (golden histories.under_lock; contract §4.5): each row as written, through the
// installer. The seam `before_lock` is another run changing the skill's lock.json entry after this run's first read and
// before it takes the lock: it's armed at the run's first look at the skill's folder and made at the next catalog call
// (the fetch that comes before the lock in install, update and accept alike), so a `publish` in it can wait for the
// catalog. Catalog reads are counted from the moment the lock file is made. Nothing here fills in an expected value.
import { dirname, join } from 'node:path';
import { CatalogError, actAs, type Catalog } from '@skills-catalog/core';
import { fingerprint, sha256Hex, type RiskFlag } from '@skills-catalog/core/skill-tree';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { pendingHold } from '../src/machine/installer.ts';
import { readLock } from '../src/machine/lock.ts';
import { race } from './race-fs.ts';
import { S, accept, clearHooks, ctxFor, install, refusalOf, unformat, update } from './race.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));

const histories = loadGolden('histories.yaml');
const table = histories.under_lock ?? histories.histories.under_lock;
const NAME: string = table.name;
const versions = histories.versions as Record<string, Record<string, string>>;
const policy = MACHINE_RUNS['set_skill_update_policy']!;

type Change = { version?: number; files?: string; catalog?: 'other'; policy?: string; removed?: true };
type Seam = { before_lock: { entry?: Change; publish?: { version: number; files: string } } };
type Row = {
  id: string;
  installed: 'none' | { version: number; files: string; policy?: string; lock_planted?: boolean };
  plant: { version: number; files: string }[];
  seam?: Seam;
  then_accept_seam?: Seam;
  update_names?: string[];
  update?: { held?: string; version?: number; was?: string; now?: string; target?: string; risk_flags?: RiskFlag[]; unchanged?: { version: number }; updated?: { from: number; to: number }; results?: []; refused?: { version: number; error: string } };
  install?: { held?: string; version?: number; from?: number; was?: string; now?: string; target?: string; unchanged?: { version: number } };
  accept?: { error: string; name: string; held: boolean };
  lock_after?: 'seam';
  lock_version?: number;
  installed_unchanged?: true;
  installed_as?: string;
  nothing_replaced?: true;
  no_lock_entry?: true;
  no_new_skill_dirs?: true;
  catalog_reads_under_lock?: number;
};

type Entry = Record<string, unknown>;
const lockFile = (p: Place) => join(p.home, 'lock.json');
const destOf = (p: Place) => join(p.osHome, '.claude', 'skills', NAME);
const readLockJson = (p: Place): { skills: Record<string, Entry> } =>
  race.fs.existsSync(lockFile(p)) ? JSON.parse(race.fs.readFileSync(lockFile(p), 'utf8')) : { skills: {} };
const filesIn = (dir: string): Record<string, string> =>
  Object.fromEntries(race.fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => race.fs.statSync(join(dir, f)).isFile()).sort().map((f) => [f, race.fs.readFileSync(join(dir, f), 'utf8')]));
const kinds = (flags: RiskFlag[]) => [...new Set(flags.map((f) => f.kind))];
const heldOf = (text: string) => {
  const m = /target "([^"]+)", version (\d+), confirm "([^"]+)" and flags (\[[^\]]*\])/.exec(text);
  return m ? { target: m[1]!, version: Number(m[2]), confirm: m[3]!, flags: JSON.parse(m[4]!) as string[] } : undefined;
};

async function publish(p: Place, files: Record<string, string>): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(NAME, Object.entries(files).map(([path, text]) => ({ path, text }))), actAs('ana'));
  } finally {
    c.close();
  }
}

// A copy placed at the skill's path as another run would: its files (0644), and the entry fields that record it.
function placeCopy(dest: string, files: Record<string, string>): Entry {
  if (race.fs.existsSync(dest)) race.fs.rmSync(dest, { recursive: true });
  for (const [path, text] of Object.entries(files)) {
    race.fs.mkdirSync(dirname(join(dest, path)), { recursive: true });
    race.fs.writeFileSync(join(dest, path), text, { mode: 0o644 });
  }
  race.fs.chmodSync(dest, 0o755);
  const st = race.fs.statSync(dest, { bigint: true });
  const part = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString());
  return {
    fingerprint: fingerprint(Object.entries(files).map(([path, text]) => ({ path, mode: '0644' as const, sha256: sha256Hex(Buffer.from(text)) }))),
    copy: { dev: part(st.dev), ino: part(st.ino), ...(st.birthtimeMs ? { birth: part(st.birthtimeMs) } : {}) },
  };
}

// Rows this runner can't run yet, and why (reported as skipped, never as passed).
const CANT: Record<string, string> = {};

describe('decisions are taken under the lock (golden histories.under_lock)', () => {
  for (const row of table.cases as Row[]) {
    const why = CANT[row.id];
    (why ? it.skip : it)(`under_lock ${row.id}${why ? ` (${why})` : ''}`, async () => {
      const p = place();
      const dest = destOf(p);
      // Catalog reads, counted once the lock file is made; the seam runs at the first catalog call after it's armed.
      let armed = false;
      let seam: (() => Promise<void>) | undefined;
      let locked = false;
      let reads = 0;
      const wrap = (c: Catalog): Catalog =>
        new Proxy(c, {
          get(t, k) {
            const v = Reflect.get(t, k) as unknown;
            if (typeof v !== 'function') return v;
            return async (...a: unknown[]) => {
              if (armed && seam) {
                const s = seam;
                seam = undefined;
                await s();
              }
              if (locked) reads++;
              return (v as (...x: unknown[]) => unknown).apply(t, a);
            };
          },
        });
      const ctx = ctxFor(p, wrap);
      const CATALOG = ctx.settings.catalog;
      const OTHER = CATALOG.replace(/[^/]+\/?$/, 'other-catalog');
      const vars = (v: string | undefined) => v?.replace('$OTHER_CATALOG', OTHER).replace('$CATALOG', CATALOG);

      // The catalog's versions, and the installed copy at its version.
      const [first, ...rest] = [...row.plant].sort((a, b) => a.version - b.version);
      await publish(p, versions[first!.files]!);
      if (row.installed !== 'none') {
        // A first install of a version with flags is held; the person's yes installs it.
        if ((await install(ctx, { name: NAME, version: row.installed.version })).outcome === 'held') {
          const { target, version, confirm, flags } = (await pendingHold(ctx, NAME)) as { target: 'user'; version: number; confirm: string; flags: string[] };
          await accept(ctx, { name: NAME, target, version, confirm, flags });
        }
        expect(readLock(p.home).skills[dest]?.version).toBe(row.installed.version);
        if (row.installed.lock_planted) {
          const lock = readLockJson(p);
          Object.assign(lock.skills[dest]!, placeCopy(dest, versions[row.installed.files]!));
          race.fs.writeFileSync(lockFile(p), JSON.stringify(lock, null, 2) + '\n');
        }
        expect(filesIn(dest)).toEqual(versions[row.installed.files]);
        if (row.installed.policy) await policy(ctx, { name: NAME, policy: row.installed.policy });
      }
      for (const v of rest) await publish(p, versions[v.files]!);

      // The other run's change: the entry's fields, a copy placed for a version with files, or the entry and copy removed.
      let seamLock: string | undefined;
      let seamCopy: bigint | undefined;
      const arm = (s: Seam) => {
        seam = async () => {
          if (s.before_lock.publish) await publish(p, versions[s.before_lock.publish.files]!);
          const c = s.before_lock.entry ?? {};
          const lock = readLockJson(p);
          if (c.removed) {
            delete lock.skills[dest];
            race.fs.rmSync(dest, { recursive: true, force: true });
          } else {
            const e: Entry = lock.skills[dest] ?? { name: NAME, target: 'user', publisher: 'ana', path: dest, installed_at: new Date().toISOString(), catalog: CATALOG, accepted: [] };
            if (c.files) Object.assign(e, placeCopy(dest, versions[c.files]!));
            if (c.version !== undefined) e['version'] = c.version;
            if (c.catalog === 'other') e['catalog'] = OTHER;
            if (c.policy) e['policy'] = c.policy;
            lock.skills[dest] = e as Entry;
          }
          seamLock = JSON.stringify(lock, null, 2) + '\n';
          race.fs.mkdirSync(p.home, { recursive: true, mode: 0o700 });
          race.fs.writeFileSync(lockFile(p), seamLock);
          seamCopy = race.fs.existsSync(dest) ? race.fs.statSync(dest, { bigint: true }).ino : undefined;
        };
        race.onLstat = (path) => {
          if (path === dest) armed = true;
        };
        race.onOpen = (path, flags) => {
          if (path === join(p.home, 'lock.json.lock') && flags === 'wx') locked = true;
        };
      };

      let r: unknown;
      try {
        if (row.accept) {
          const held = await pendingHold(ctx, NAME);
          expect(held && 'confirm' in held).toBe(true);
          const { target, version, confirm, flags } = held as { target: 'user'; version: number; confirm: string; flags: string[] };
          arm(row.then_accept_seam!);
          r = await accept(ctx, { name: NAME, target, version, confirm, flags }).catch((e: unknown) => e);
        } else {
          arm(row.seam!);
          r = row.install ? await install(ctx, { name: NAME }) : await update(ctx, row.update_names ? { names: row.update_names } : {});
        }
      } finally {
        clearHooks();
      }
      expect(seamLock, 'the seam ran before the lock').toBeDefined();

      const done = r as { text: string; outcome?: string; result?: string };
      if (row.accept) {
        expect([(r as CatalogError).code, (r as CatalogError).data]).toEqual([row.accept.error, { name: row.accept.name, held: row.accept.held }]);
      }
      const e = row.install ?? row.update;
      if (e?.held) {
        const face = row.install ? 'install' : 'update';
        const key = e.held === 'flagged' ? (row.install ? 'held' : 'held_flagged') : `held_${e.held}`;
        expect(done.result).toBe(S.doc.log.result[face][key]);
        const held = heldOf(done.text);
        expect(held, 'the held result gives target, version and confirm').toBeDefined();
        if (e.version !== undefined) expect(held!.version).toBe(e.version);
        if (e.target !== undefined) expect(held!.target).toBe(e.target);
        if ('risk_flags' in e && e.risk_flags) expect(held!.flags).toEqual(kinds(e.risk_flags));
        if (e.was !== undefined) expect([done.text.includes(vars(e.was)!), done.text.includes(vars(e.now)!)]).toEqual([true, true]);
        if (row.install && 'from' in e && e.from !== undefined) expect(done.text).toContain(`${NAME} v${e.from}`);
      }
      if (e?.unchanged) {
        if (row.install) expect([done.outcome, done.text]).toEqual(['unchanged', S.format(S.word('install').unchanged, { name: NAME, version: e.unchanged.version })]);
        else expect(done.text.split('\n')).toEqual([S.format(S.word('update').header, { checked: 1 }), S.format(S.word('update').unchanged, { n: 1 })]);
        expect(readLock(p.home).skills[dest]!.version).toBe(e.unchanged.version);
      }
      if (row.update?.updated) {
        const line = done.text.split('\n').map((l) => unformat(S.word('update').updated, l.split(S.word('update').kept_in_staging.split('{')[0]!)[0]!)).find(Boolean);
        expect(line && { from: Number(line['from']), to: Number(line['to']) }).toEqual(row.update.updated);
        if (row.update.risk_flags) expect(done.outcome).toBe('updated');
      }
      if (row.update?.results) expect(done.text.split('\n')).toEqual([S.format(S.word('update').header, { checked: 1 })]);
      if (row.update?.refused) {
        const { code } = refusalOf(r);
        expect(code ?? done.text).toContain(row.update.refused.error);
        expect(done.text).toContain(`${NAME} v`);
      }

      if (row.lock_after === 'seam') expect(race.fs.readFileSync(lockFile(p), 'utf8')).toBe(seamLock);
      if (row.lock_version !== undefined) expect(readLock(p.home).skills[dest]!.version).toBe(row.lock_version);
      if (row.installed_unchanged && row.installed !== 'none') expect(filesIn(dest)).toEqual(versions[row.installed.files]);
      if (row.installed_as) expect(filesIn(dest)).toEqual(versions[row.installed_as]);
      if (row.nothing_replaced) expect(race.fs.statSync(dest, { bigint: true }).ino).toBe(seamCopy);
      if (row.no_lock_entry) expect(readLockJson(p).skills[dest]).toBeUndefined();
      if (row.no_new_skill_dirs) expect(race.fs.existsSync(dest)).toBe(false);
      if (row.catalog_reads_under_lock !== undefined) expect(reads).toBe(row.catalog_reads_under_lock);
    });
  }
});
