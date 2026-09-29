// Links swapped in and out while the installer runs (the security review's races), through a mocked node:fs whose
// lstatSync and renameSync call the test's hooks first. The installer deletes a moved-aside folder only when it is the
// copy the lock recorded (contract §4.5, "Replacing an installed copy, safely"); a first install never moves what it
// finds; and whatever it can't put back is named, never stranded in silence.
import { join } from 'node:path';
import { Surface, actAs, type Catalog } from '@skills-catalog/core';
import { describe, expect, it, vi } from 'vitest';
import { contextFor } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

type Fs = typeof import('node:fs');
// The real node:fs (for the tests' own swaps), and the hooks every lstatSync and renameSync call runs first.
const race = vi.hoisted(() => ({
  fs: undefined as unknown as Fs,
  onLstat: undefined as undefined | ((path: string) => void),
  onRename: undefined as undefined | ((from: string, to: string) => void),
  afterRename: undefined as undefined | ((from: string, to: string) => void),
}));
vi.mock('node:fs', async (original) => {
  const fs = await original<Fs>();
  race.fs = fs;
  const lstatSync = ((path: string, ...rest: unknown[]) => {
    race.onLstat?.(String(path));
    return (fs.lstatSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as Fs['lstatSync'];
  const renameSync = (from: string, to: string) => {
    race.onRename?.(String(from), String(to));
    fs.renameSync(from, to);
    race.afterRename?.(String(from), String(to));
  };
  return { ...fs, lstatSync, renameSync, default: { ...fs, lstatSync, renameSync } };
});

const S = Surface.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const update = MACHINE_RUNS['update_installed_skills']!;

const ctxFor = (p: Place, wrap?: (c: Catalog) => Catalog) => {
  const { ctx } = contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project')), S, 'mcp');
  return wrap ? { ...ctx, catalog: async () => wrap(await ctx.catalog()) } : ctx;
};

async function publish(p: Place, name: string, body: string): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(name, [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`, body) }]), actAs('ana'));
  } finally {
    c.close();
  }
}

const refused = (e: unknown) => e as { code?: string; data?: Record<string, unknown>; text?: string };
// A refusal is thrown by install and accept, and is a skill's refused line in update's result: read it from either.
const codeOf = (r: unknown) => refused(r).code ?? /(target_changed|target_symlink|exists_untracked)/.exec(refused(r).text ?? '')?.[1];
const stagedOf = (r: unknown) => (refused(r).data?.['staging'] as string | undefined) ?? /"staging":"([^"]+)"/.exec(refused(r).text ?? '')?.[1];
const stagingDir = (p: Place) => join(p.dir, 'project', '.claude', '.skills-catalog-staging');
const stagingEntries = (p: Place) => (race.fs.existsSync(stagingDir(p)) ? race.fs.readdirSync(stagingDir(p)).map((e) => join(stagingDir(p), e)) : []);

// The project's skills folder S, and victim/ V holding alpha/canary: someone else's folder a link can point at.
function places(p: Place) {
  const skills = join(p.dir, 'project', '.claude', 'skills');
  const victim = join(p.dir, 'victim');
  const canary = join(victim, 'alpha', 'canary');
  race.fs.mkdirSync(join(victim, 'alpha'), { recursive: true });
  race.fs.writeFileSync(canary, 'keep me\n');
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
function doubleSwapAt(p: Place, k: number, pl: ReturnType<typeof places>, side: 'before' | 'after'): () => boolean {
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

const clearHooks = () => {
  race.onLstat = undefined;
  race.onRename = undefined;
  race.afterRename = undefined;
};

describe('links swapped in while the installer replaces a copy (the security review\'s races)', () => {
  it('a link swapped in exactly when the installed copy is moved aside: put back, refused, nothing deleted', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const ctx = ctxFor(p);
    await install(ctx, { name: 'alpha', target: 'project' });
    await publish(p, 'alpha', 'Second, markdown only.\n');
    const skills = join(p.dir, 'project', '.claude', 'skills');
    const dest = join(skills, 'alpha');
    const victim = join(p.dir, 'victim');
    race.fs.mkdirSync(join(victim, 'alpha'), { recursive: true });
    race.fs.writeFileSync(join(victim, 'alpha', 'canary'), 'keep me\n');
    const lockBefore = race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8');

    race.onRename = (from) => {
      if (from !== dest) return;
      race.onRename = undefined;
      race.fs.renameSync(skills, join(p.dir, 'aside'));
      race.fs.symlinkSync(victim, skills);
    };
    let r: unknown;
    try {
      r = await update(ctx, {}).catch((e: unknown) => e);
    } finally {
      clearHooks();
    }
    expect(['target_symlink', 'target_changed']).toContain(codeOf(r));
    // Never deleted: back in place, or in the staging folder the refusal names.
    const staged = stagedOf(r);
    const canaryAt = race.fs.existsSync(join(victim, 'alpha', 'canary')) ? join(victim, 'alpha', 'canary') : staged && join(staged, 'canary');
    expect(canaryAt && race.fs.readFileSync(canaryAt, 'utf8')).toBe('keep me\n');
    expect(race.fs.readdirSync(join(canaryAt!, '..'))).toEqual(['canary']);
    expect(stagingEntries(p)).toEqual(staged === undefined ? [] : [staged]);
    expect(race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);
    expect(race.fs.readFileSync(join(p.dir, 'aside', 'alpha', 'SKILL.md'), 'utf8')).toBe(skillMd('alpha', 'The alpha skill.', 'Body.\n'));
  });

  it('a double swap on a first install (in at any check, out at the next move) never deletes or moves the linked folder', async () => {
    for (const side of ['before', 'after'] as const) for (let k = 0; k < 16; k++) {
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
  });

  // §4.5: a folder moved aside that isn't the recorded copy is moved back, or, when it can't be (the real copy is back in
  // its place), left where it was moved to and named by target_changed's `staging`. Never deleted either way.
  it('a double swap while replacing an installed copy: the linked folder is never deleted, and nothing is stranded unnamed', async () => {
    for (const side of ['before', 'after'] as const) for (let k = 0; k < 16; k++) {
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
  });
});

// The review's probes, each at one exact point. An update of alpha, installed in the project, to a markdown-only v2.
describe('the review\'s probes (B, B2, C, D)', () => {
  async function installed(): Promise<{ p: Place; ctx: ReturnType<typeof ctxFor>; claude: string; skills: string; dest: string; lockBefore: string }> {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const ctx = ctxFor(p);
    await install(ctx, { name: 'alpha', target: 'project' });
    await publish(p, 'alpha', 'Second, markdown only.\n');
    const claude = join(p.dir, 'project', '.claude');
    return { p, ctx, claude, skills: join(claude, 'skills'), dest: join(claude, 'skills', 'alpha'), lockBefore: race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8') };
  }
  const folder = (dir: string, files: Record<string, string>) => {
    for (const [f, text] of Object.entries(files)) {
      race.fs.mkdirSync(join(dir, f, '..'), { recursive: true });
      race.fs.writeFileSync(join(dir, f), text);
    }
  };
  const tree = (dir: string): string[] => (race.fs.existsSync(dir) ? race.fs.readdirSync(dir, { recursive: true }).map(String).sort() : []);
  const relink = (link: string, to: string) => {
    if (race.fs.lstatSync(link).isSymbolicLink()) race.fs.unlinkSync(link);
    else race.fs.renameSync(link, `${link}.real`);
    race.fs.symlinkSync(to, link);
  };
  async function run(s: Awaited<ReturnType<typeof installed>>): Promise<{ text: string; staged?: string }> {
    let r: unknown;
    try {
      r = await update(s.ctx, {}).catch((e: unknown) => e);
    } finally {
      clearHooks();
    }
    expect(refused(r).text, 'a refused line, never a thrown raw error').toBeTypeOf('string');
    const text = refused(r).text!;
    expect(text).not.toMatch(/ENOTEMPTY|ENOENT|internal_error/);
    expect(text).not.toContain(S.format(S.word('update.updated'), { name: 'alpha', from: 1, to: 2, changes: '"SKILL.md" changed' }));
    expect(codeOf(r)).toBe('target_changed');
    expect(race.fs.readFileSync(join(s.p.home, 'lock.json'), 'utf8')).toBe(s.lockBefore);
    const staged = stagedOf(r);
    // Everything left in staging is named: one folder by its path, several by the staging folder itself.
    expect(staged === stagingDir(s.p) ? stagingEntries(s.p).length > 1 : true).toBe(true);
    if (staged !== stagingDir(s.p)) expect(stagingEntries(s.p)).toEqual(staged === undefined ? [] : [staged]);
    return { text, staged };
  }

  it('B: the put-back fails (the skills folder relinked to W, W/alpha refilled): target_changed names the staging path', async () => {
    const s = await installed();
    const w = join(s.p.dir, 'w');
    folder(w, { 'alpha/canary': 'keep me\n' });
    race.onRename = (from) => {
      if (from !== s.dest) return;
      race.onRename = undefined;
      relink(s.skills, w);
    };
    race.afterRename = (from) => {
      if (from !== s.dest) return;
      race.afterRename = undefined;
      folder(w, { 'alpha/theirs': 'new\n' });
    };
    const { staged } = await run(s);
    expect(race.fs.readFileSync(join(staged!, 'canary'), 'utf8')).toBe('keep me\n');
    expect(tree(join(w, 'alpha'))).toEqual(['theirs']);
  });

  it('B2: the put-back would land in another link target (W2): the folder is taken back out, nothing is written into W2', async () => {
    const s = await installed();
    const w = join(s.p.dir, 'w');
    const w2 = join(s.p.dir, 'w2');
    folder(w, { 'alpha/canary': 'keep me\n' });
    race.fs.mkdirSync(w2);
    race.onRename = (from) => {
      if (from !== s.dest) return;
      race.onRename = undefined;
      relink(s.skills, w);
    };
    race.afterRename = (from) => {
      if (from !== s.dest) return;
      race.afterRename = undefined;
      relink(s.skills, w2);
    };
    const { staged } = await run(s);
    expect(tree(w2)).toEqual([]);
    expect(race.fs.readFileSync(join(staged!, 'canary'), 'utf8')).toBe('keep me\n');
  });

  it('C: .claude swapped for a link right after its check: nothing deleted or written outside', async () => {
    for (const theirs of [{ 'skills/alpha/canary': 'keep me\n' }, { 'skills/other': 'x\n' }] as Record<string, string>[]) {
      const s = await installed();
      const v = join(s.p.dir, 'v');
      folder(v, theirs);
      const before = tree(v);
      let seen = 0;
      // skills' second lstat comes right after .claude's check in the folder checks before the write.
      race.onLstat = (path) => {
        if (path === s.skills && ++seen === 2) relink(s.claude, v);
      };
      await run(s);
      expect(tree(v)).toEqual(before);
      if ('skills/alpha/canary' in theirs) expect(race.fs.readFileSync(join(v, 'skills', 'alpha', 'canary'), 'utf8')).toBe('keep me\n');
    }
  });

  it('D: skills swapped right after its check: the identity is the real folder\'s, and nothing there is touched', async () => {
    const s = await installed();
    const v = join(s.p.dir, 'v');
    folder(v, { 'alpha/canary': 'keep me\n' });
    let seen = 0;
    race.onLstat = (path) => {
      if (path === s.skills && ++seen === 2) race.onLstat = () => relink(s.skills, v);
    };
    await run(s);
    expect(tree(join(v, 'alpha'))).toEqual(['canary']);
    // The person's copy wasn't touched: it's in the real folder, which the swap moved aside.
    expect(race.fs.readFileSync(join(`${s.skills}.real`, 'alpha', 'SKILL.md'), 'utf8')).toBe(skillMd('alpha', 'The alpha skill.', 'Body.\n'));
  });

  it('the take-back re-pointed: skills links to V as the new copy goes in, then to V2 (holding alpha/canary) as it is taken back; V2\'s folder is never deleted', async () => {
    const s = await installed();
    const v = join(s.p.dir, 'v');
    const v2 = join(s.p.dir, 'v2');
    race.fs.mkdirSync(v);
    folder(v2, { 'alpha/canary': 'keep me\n' });
    // The new copy's move in (from the staging folder to the skill's path), then the first move out of the skill's path
    // after it (the take-back).
    let placing = true;
    race.onRename = (from, to) => {
      if (placing && to === s.dest && from.includes('.skills-catalog-staging')) {
        placing = false;
        relink(s.skills, v);
      } else if (!placing && from === s.dest) {
        race.onRename = undefined;
        relink(s.skills, v2);
      }
    };
    const { staged } = await run(s);
    const canaryAt = [join(v2, 'alpha'), ...stagingEntries(s.p)].map((d) => join(d, 'canary')).find((f) => race.fs.existsSync(f));
    expect(staged, 'whatever is left in staging is named').toBeDefined();
    expect(canaryAt && race.fs.readFileSync(canaryAt, 'utf8')).toBe('keep me\n');
  });

  it('swapped to V as the new copy goes in and straight back: the result says the new copy may be elsewhere, and names the replaced one', async () => {
    const s = await installed();
    const v = join(s.p.dir, 'v');
    race.fs.mkdirSync(v);
    race.onRename = (from, to) => {
      if (to !== s.dest || !from.includes('.skills-catalog-staging')) return;
      race.onRename = undefined;
      relink(s.skills, v);
    };
    race.afterRename = (_from, to) => {
      if (to !== s.dest) return;
      race.afterRename = undefined;
      race.fs.unlinkSync(s.skills);
      race.fs.renameSync(`${s.skills}.real`, s.skills);
    };
    const { text, staged } = await run(s);
    expect(text).toContain('"elsewhere":true');
    // The new copy went where the link pointed; the person's copy is in staging, named.
    expect(race.fs.readFileSync(join(v, 'alpha', 'SKILL.md'), 'utf8')).toContain('Second, markdown only.');
    expect(race.fs.readFileSync(join(staged!, 'SKILL.md'), 'utf8')).toBe(skillMd('alpha', 'The alpha skill.', 'Body.\n'));
  });
});
