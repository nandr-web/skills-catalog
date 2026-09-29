// Shared by the race tests (installer-race.test.ts, and the full sweeps in installer-race-sweep.test.ts, a slow file):
// places, the swaps, what a refusal says, and the sweeps themselves. Each test file mocks node:fs through race-fs.ts first.
import { join } from 'node:path';
import { Words, actAs, type Catalog } from '@skills-catalog/core';
import { expect, it } from 'vitest';
import { contextFor } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { settingsFrom } from '../src/settings.ts';
import { race } from './race-fs.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

export const S = Words.load();
export const install = MACHINE_RUNS['install_shared_skill']!;
export const update = MACHINE_RUNS['update_installed_skills']!;
export const accept = MACHINE_RUNS['accept_held_update']!;

export const ctxFor = (p: Place, wrap?: (c: Catalog) => Catalog) => {
  const { ctx } = contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed }, join(p.dir, 'project')), S, 'mcp');
  return wrap ? { ...ctx, catalog: async () => wrap(await ctx.catalog()) } : ctx;
};

export async function publish(p: Place, name: string, body: string): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(name, [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`, body) }]), actAs('ana'));
  } finally {
    c.close();
  }
}

export const refused = (e: unknown) => e as { code?: string; data?: Record<string, unknown>; text?: string };
// A refusal is thrown by install and accept, and is a skill's refused line in update's result: read it from either.
// A sentence's slots read back from a line it made: the words file's own words, never hand-typed ones.
export function unformat(template: string, line: string): Record<string, string> | undefined {
  const slots: string[] = [];
  const marked = S.format(template, Object.fromEntries([...template.matchAll(/\{(\w+)\}/g)].map(([, k]) => [k, `\u0001${k}\u0002`])));
  const pattern = marked.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\u0001(\w+)\u0002/g, (_, k: string) => (slots.push(k), '(.+?)'));
  const m = new RegExp(`^${pattern}$`).exec(line);
  return m ? Object.fromEntries(slots.map((k, i) => [k, m[i + 1]!])) : undefined;
}
/** The refusal: a thrown error's code and data, or an update's refused line read back through the words it was made from. */
export function refusalOf(r: unknown): { code?: string; data: Record<string, unknown> } {
  const e = refused(r);
  if (e.code) return { code: e.code, data: e.data ?? {} };
  const u = S.word('update');
  const tail = S.format(S.word('errors').target_changed_elsewhere);
  for (const line of (e.text ?? '').split('\n')) {
    const elsewhere = line.endsWith(tail);
    const body = elsewhere ? line.slice(0, -tail.length) : line;
    for (const [key, extra] of [['target_changed_staging', {}], ['target_changed_temp', { temp: true }], ['target_changed', {}]] as const) {
      const m = unformat(u[key], body);
      if (m) return { code: 'target_changed', data: { ...m, ...extra, ...(elsewhere ? { elsewhere: true } : {}) } };
    }
    const m = unformat(u.refused_target, body);
    if (m) for (const [code, w] of Object.entries(u.target_reason as Record<string, string>)) {
      const why = unformat(w, m['reason']!);
      if (why) return { code, data: why };
    }
  }
  return { data: {} };
}
export const codeOf = (r: unknown) => refusalOf(r).code;
export const stagedOf = (r: unknown) => refusalOf(r).data['staging'] as string | undefined;
export const stagingDir = (p: Place) => join(p.dir, 'project', '.claude', '.skills-catalog-staging');
// What's in staging besides its .gitignore.
export const stagingEntries = (p: Place) => (race.fs.existsSync(stagingDir(p)) ? race.fs.readdirSync(stagingDir(p)).filter((e) => e !== '.gitignore').map((e) => join(stagingDir(p), e)) : []);

// The project's skills folder S, and victim/ V holding alpha/canary: someone else's folder a link can point at.
// `holds`: what V has at alpha: a canary (someone's folder), nothing, or an empty folder.
export function places(p: Place, holds: 'canary' | 'none' | 'empty' = 'canary') {
  const skills = join(p.dir, 'project', '.claude', 'skills');
  const victim = join(p.dir, 'victim');
  const canary = join(victim, 'alpha', 'canary');
  race.fs.mkdirSync(holds === 'none' ? victim : join(victim, 'alpha'), { recursive: true });
  if (holds === 'canary') race.fs.writeFileSync(canary, 'keep me\n');
  const aside = join(p.dir, 'aside');
  const toVictim = () => {
    race.fs.mkdirSync(skills, { recursive: true });
    race.fs.renameSync(skills, aside);
    race.fs.symlinkSync(victim, skills);
  };
  const back = () => {
    race.fs.unlinkSync(skills);
    race.fs.renameSync(aside, skills);
  };
  return { skills, victim, canary, toVictim, back };
}

// Swaps S for a link to V at the k-th lstat of a path under the project's .claude, and back just before or just after the
// next rename: every such interleaving of a racer swapping in and out, one per k and side. Returns whether it swapped.
export function doubleSwapAt(p: Place, k: number, pl: ReturnType<typeof places>, side: 'before' | 'after'): () => boolean {
  const claude = join(p.dir, 'project', '.claude');
  let seen = 0;
  let state: 'waiting' | 'swapped' | 'done' = 'waiting';
  race.onLstat = (path) => {
    if (state !== 'waiting' || !path.startsWith(claude)) return;
    if (seen++ !== k) return;
    state = 'swapped';
    pl.toVictim();
  };
  race[side === 'before' ? 'onRename' : 'afterRename'] = () => {
    if (state !== 'swapped') return;
    state = 'done';
    pl.back();
  };
  // After the call: if the installer refused before any move, the racer still swaps back, so the test looks at S.
  return () => {
    if (state === 'swapped') {
      state = 'done';
      pl.back();
    }
    return state !== 'waiting';
  };
}

// Each sweep runs a whole install or update per interleaving (the slow file's full sweeps take about 5 s together at a
// load of 12); room for a loaded machine.
export const SWEEP_MS = 30_000;

export const clearHooks = () => {
  race.onLstat = undefined;
  race.onRename = undefined;
  race.afterRename = undefined;
  race.stats = undefined;
  race.onWrite = undefined;
  race.onOpen = undefined;
};

/** The swap sweeps: every interleaving up to the k-th check. The fast suite runs a small bound; the slow one reaches every
 *  check an install or update makes. */
export function sweeps(K: number): void {
  it('a double swap on a first install (in at any check, out at the next move) never deletes or moves the linked folder', async () => {
    for (const side of ['before', 'after'] as const) for (let k = 0; k < K; k++) {
      const p = place();
      await publish(p, 'alpha', 'Body.\n');
      const pl = places(p);
      const swapped = doubleSwapAt(p, k, pl, side);
      let r: unknown;
      try {
        r = await install(ctxFor(p), { name: 'alpha', target: 'project' }).catch((e: unknown) => e);
      } finally {
        clearHooks();
      }
      if (!swapped()) break;
      expect(race.fs.existsSync(pl.canary) && race.fs.readFileSync(pl.canary, 'utf8'), `${side} k=${k}`).toBe('keep me\n');
      expect(race.fs.readdirSync(join(pl.victim, 'alpha')), `${side} k=${k}`).toEqual(['canary']);
      // Nothing is left in staging unless the refusal names it.
      const staged = stagedOf(r);
      expect(stagingEntries(p), `${side} k=${k}`).toEqual(staged === undefined ? [] : [staged]);
    }
  }, SWEEP_MS);

  // §4.5: a folder moved aside that isn't the recorded copy is moved back, or, when it can't be (the real copy is back in
  // its place), left where it was moved to and named by target_changed's `staging`. Never deleted either way.
  it('a double swap while replacing an installed copy: the linked folder is never deleted, and nothing is stranded unnamed', async () => {
    for (const side of ['before', 'after'] as const) for (let k = 0; k < K; k++) {
      const p = place();
      await publish(p, 'alpha', 'Body.\n');
      const ctx = ctxFor(p);
      await install(ctx, { name: 'alpha', target: 'project' });
      await publish(p, 'alpha', 'Second, markdown only.\n');
      const pl = places(p);
      const swapped = doubleSwapAt(p, k, pl, side);
      let r: unknown;
      try {
        r = await update(ctx, {}).catch((e: unknown) => e);
      } finally {
        clearHooks();
      }
      if (!swapped()) break;
      const staged = stagedOf(r);
      const canaryAt = race.fs.existsSync(pl.canary) ? pl.canary : staged && join(staged, 'canary');
      expect(canaryAt && race.fs.readFileSync(canaryAt, 'utf8'), `${side} k=${k}`).toBe('keep me\n');
      expect(race.fs.readdirSync(join(canaryAt!, '..')), `${side} k=${k}`).toEqual(['canary']);
      expect(stagingEntries(p), `${side} k=${k}`).toEqual(staged === undefined ? [] : [staged]);
      // The person's copy is in place at the old or the new version, or, when it couldn't be put back, in the named
      // staging folder.
      const installedAt = race.fs.existsSync(join(pl.skills, 'alpha', 'SKILL.md')) ? join(pl.skills, 'alpha') : staged;
      expect(installedAt && race.fs.readFileSync(join(installedAt, 'SKILL.md'), 'utf8'), `${side} k=${k}`).toMatch(/Body\.|Second, markdown only\./);
    }
  }, SWEEP_MS);

  // Around the new copy's move in: V holds nothing at alpha, or an empty folder, so the move can land there. Whenever a
  // copy made here ends up in V, the result says so (`elsewhere`), and never reports success.
  it('a new copy that lands where a swapped-in link pointed is always reported (V without alpha, or with an empty alpha)', async () => {
    let landings = 0;
    for (const holds of ['none', 'empty'] as const) {
      for (const op of ['install', 'update'] as const) {
        for (const side of ['before', 'after'] as const) {
          for (let k = 0; k < K; k++) {
            const p = place();
            await publish(p, 'alpha', 'Body.\n');
            const ctx = ctxFor(p);
            if (op === 'update') {
              await install(ctx, { name: 'alpha', target: 'project' });
              await publish(p, 'alpha', 'Second, markdown only.\n');
            }
            const pl = places(p, holds);
            const swapped = doubleSwapAt(p, k, pl, side);
            let r: unknown;
            try {
              r = await (op === 'install' ? install(ctx, { name: 'alpha', target: 'project' }) : update(ctx, {})).catch((e: unknown) => e);
            } finally {
              clearHooks();
            }
            if (!swapped()) break;
            const label = `${holds} ${op} ${side} k=${k}`;
            const landed = race.fs.existsSync(join(pl.victim, 'alpha', 'SKILL.md'));
            const text = refused(r).text ?? '';
            const saidElsewhere = refusalOf(r).data['elsewhere'] === true;
            if (landed) landings++;
            if (landed) expect(saidElsewhere, label).toBe(true);
            if (landed) expect(text, label).not.toMatch(/^Installed|Updated/m);
            const staged = stagedOf(r);
            expect(stagingEntries(p).length === 0 || staged !== undefined, label).toBe(true);
          }
        }
      }
    }
    // The sweep reaches the case it's about.
    expect(landings).toBeGreaterThan(0);
  }, SWEEP_MS * 2);
}
