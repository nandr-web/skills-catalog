// Links swapped in and out while the installer runs (the security review's races), through a mocked node:fs whose
// lstatSync and renameSync call the test's hooks first. The installer deletes a moved-aside folder only when it is the
// copy the lock recorded (contract §4.5, "Replacing an installed copy, safely"); a first install never moves what it
// finds; and whatever it can't put back is named, never stranded in silence.
import { join } from 'node:path';
import { actAs } from '@skills-catalog/core';
import { describe, expect, it, vi } from 'vitest';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { race } from './race-fs.ts';
import { S, accept, clearHooks, codeOf, ctxFor, install, publish, refused, stagedOf, stagingDir, stagingEntries, sweeps, update } from './race.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

vi.mock('node:fs', async (original) => (await import('./race-fs.ts')).mockFs(await original()));

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

  // A small bound here; installer-race-sweep.test.ts (slow) reaches every check.
  sweeps(16);
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
    // The new copy went where the link pointed; the person's copy is back in place, since the path leads home again.
    expect(race.fs.readFileSync(join(v, 'alpha', 'SKILL.md'), 'utf8')).toContain('Second, markdown only.');
    expect(staged).toBeUndefined();
    expect(race.fs.readFileSync(join(s.dest, 'SKILL.md'), 'utf8')).toBe(skillMd('alpha', 'The alpha skill.', 'Body.\n'));
  });

  it('the refusal names the first folder that failed its check: .claude or the skills folder, swapped once the copy is moved aside', async () => {
    for (const which of ['claude', 'skills'] as const) {
      const s = await installed();
      const v = join(s.p.dir, 'v');
      race.fs.mkdirSync(join(v, 'skills'), { recursive: true });
      const swapped = which === 'claude' ? s.claude : s.skills;
      race.afterRename = (from) => {
        if (from !== s.dest) return;
        race.afterRename = undefined;
        relink(swapped, which === 'claude' ? v : join(v, 'skills'));
      };
      let text: string;
      try {
        text = (await update(s.ctx, {})).text;
      } finally {
        clearHooks();
      }
      expect([which, codeOf({ text }), JSON.parse(/"path":("[^"]+")/.exec(text)![1]!)]).toEqual([which, 'target_changed', swapped]);
    }
  });
});

// §4.5 (fd91737): the staging folder, .claude and .claude/skills must be private to the person before anything is written
// there: owned by them, never world-writable, group-writable only with their own group. Otherwise target_not_private
// {path}, and nothing changes. In a shared checkout another user could otherwise swap what the installer writes.
describe('folders another user could control are refused (target_not_private)', () => {
  const uid = process.getuid!();

  const cases: { what: string; at: (claude: string) => string; change: Partial<import('node:fs').Stats>; own: boolean }[] = [
    { what: 'the staging folder owned by another user', at: (c) => join(c, '.skills-catalog-staging'), change: { uid: uid + 1 }, own: false },
    { what: '.claude owned by another user', at: (c) => c, change: { uid: uid + 1 }, own: false },
    { what: '.claude/skills world-writable', at: (c) => join(c, 'skills'), change: { mode: 0o040777 }, own: true },
    { what: 'the staging folder group-writable with another group', at: (c) => join(c, '.skills-catalog-staging'), change: { mode: 0o040770, gid: uid + 1 }, own: true },
    { what: '.claude group-writable with a shared group (macOS staff, 20)', at: (c) => c, change: { mode: 0o040775, gid: 20 }, own: true },
    { what: 'the project folder world-writable without the sticky bit', at: (c) => join(c, '..'), change: { mode: 0o040777 }, own: true },
  ];

  // The folder above .claude (§4.5): the person's assistant home is held to the same rule; a project folder may be anyone's,
  // but writable by others only as the private-group convention allows, or with the sticky bit (as /tmp is).
  it('the folder above .claude: the assistant home must be private; a project may be group- or world-writable only with the person\'s private group or the sticky bit', async () => {
    // `refused`: the data of the refusal, or false when it installs. The data says which folder it is (the home, on a
    // user install) and whether it's the person's own, so the words can pick the way on.
    const tries: { what: string; target: 'user' | 'project'; change: Partial<import('node:fs').Stats>; refused: false | { home?: true; own: boolean } }[] = [
      { what: 'assistant home owned by another user', target: 'user', change: { uid: uid + 1 }, refused: { home: true, own: false } },
      { what: 'assistant home group-writable with a shared group', target: 'user', change: { mode: 0o040775, gid: 20 }, refused: { home: true, own: true } },
      { what: 'assistant home world-writable, even with the sticky bit', target: 'user', change: { mode: 0o041777 }, refused: { home: true, own: true } },
      { what: 'assistant home group-writable with the person\'s private group', target: 'user', change: { mode: 0o040775, gid: uid }, refused: false },
      // A group-writable project is a path for every member of its group (on macOS usually staff, every account): allowed
      // only with the person's private group, or the sticky bit.
      { what: 'project group-writable with a shared group', target: 'project', change: { mode: 0o040775, gid: 20 }, refused: { own: true } },
      { what: 'project group-writable with the person\'s private group', target: 'project', change: { mode: 0o040775, gid: uid }, refused: false },
      { what: 'project group-writable and sticky', target: 'project', change: { mode: 0o041775, gid: 20 }, refused: false },
      { what: 'project owned by another user, not world-writable', target: 'project', change: { uid: uid + 1 }, refused: false },
      { what: 'project world-writable and sticky', target: 'project', change: { mode: 0o041777 }, refused: false },
      { what: 'project world-writable, not sticky, another user\'s', target: 'project', change: { mode: 0o040777, uid: uid + 1 }, refused: { own: false } },
    ];
    for (const t of tries) {
      const p = place();
      await publish(p, 'alpha', 'Body.\n');
      const root = t.target === 'user' ? p.osHome : join(p.dir, 'project');
      race.fs.mkdirSync(root, { recursive: true });
      race.stats = (at) => (at === root ? t.change : undefined);
      let r: unknown;
      try {
        r = await install(ctxFor(p), { name: 'alpha', target: t.target }).catch((e: unknown) => e);
      } finally {
        clearHooks();
      }
      if (t.refused) {
        expect([t.what, codeOf(r), refused(r).data]).toEqual([t.what, 'target_not_private', { path: root, target: t.target, ...t.refused }]);
        // Refused before anything is made under it.
        expect([t.what, race.fs.readdirSync(root)]).toEqual([t.what, []]);
      } else expect([t.what, race.fs.existsSync(join(root, '.claude', 'skills', 'alpha', 'SKILL.md'))]).toEqual([t.what, true]);
    }
  });

  it('each is refused before anything is written, and nothing changes', async () => {
    for (const c of cases) {
      const p = place();
      await publish(p, 'alpha', 'Body.\n');
      const claude = join(p.dir, 'project', '.claude');
      const path = c.at(claude);
      race.stats = (at) => (at === path ? c.change : undefined);
      let r: unknown;
      try {
        r = await install(ctxFor(p), { name: 'alpha', target: 'project' }).catch((e: unknown) => e);
      } finally {
        clearHooks();
      }
      expect([c.what, codeOf(r), refused(r).data]).toEqual([c.what, 'target_not_private', { path, target: 'project', own: c.own }]);
      expect(race.fs.existsSync(join(claude, 'skills', 'alpha')), c.what).toBe(false);
      expect(stagingEntries(p).filter((e) => !e.endsWith('.gitignore')), c.what).toEqual([]);
    }
  });

  it('group-writable with the person\'s private group (its gid is their uid) is allowed (umask 002 with per-user groups)', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const claude = join(p.dir, 'project', '.claude');
    race.stats = (at, s) => (at.startsWith(claude) && s.isDirectory() ? { mode: Number(s.mode) | 0o020, gid: uid } : undefined);
    try {
      await install(ctxFor(p), { name: 'alpha', target: 'project' });
    } finally {
      clearHooks();
    }
    expect(race.fs.existsSync(join(claude, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
  });

  it('an assistant home reached through a link: the folder it leads to is the one checked', async () => {
    for (const mode of [0o777, 0o755]) {
      const p = place();
      await publish(p, 'alpha', 'Body.\n');
      const real = join(p.dir, 'real-home');
      race.fs.mkdirSync(real);
      race.fs.chmodSync(real, mode);
      race.fs.symlinkSync(real, p.osHome);
      const r = await install(ctxFor(p), { name: 'alpha' }).catch((e: unknown) => e);
      if (mode === 0o777) {
        expect([codeOf(r), refused(r).data]).toEqual(['target_not_private', { path: p.osHome, target: 'user', home: true, own: true }]);
        expect(race.fs.readdirSync(real)).toEqual([]);
      } else expect(race.fs.existsSync(join(real, '.claude', 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    }
  });

  it('update and accept refuse the same way when the assistant home stopped being private, and change nothing', async () => {
    const p = place();
    await publish(p, 'alpha', 'First.\n');
    await install(ctxFor(p), { name: 'alpha' });
    const c = await open(p);
    try {
      await c.publish(request('beta', [{ path: 'SKILL.md', text: skillMd('beta', 'The beta skill.') }, { path: 'run.sh', text: '#!/bin/sh\n', mode: '0755' }]), actAs('ana'));
    } finally {
      c.close();
    }
    const held = await install(ctxFor(p), { name: 'beta' });
    const confirm = /confirm "([^"]+)"/.exec(held.text)![1]!;
    await publish(p, 'alpha', 'Second.\n');
    const skills = join(p.osHome, '.claude', 'skills');
    const lock = race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8');
    race.stats = (at) => (at === p.osHome ? { mode: 0o040777 } : undefined);
    let updated: { text: string } | undefined;
    let accepted: unknown;
    try {
      updated = await update(ctxFor(p), {});
      accepted = await accept(ctxFor(p), { name: 'beta', confirm, flags: ['runnable_file'] }).catch((e: unknown) => e);
    } finally {
      clearHooks();
    }
    expect(updated!.text).toContain('target_not_private');
    expect([codeOf(accepted), refused(accepted).data]).toEqual(['target_not_private', { path: p.osHome, target: 'user', home: true, own: true }]);
    expect(race.fs.readFileSync(join(skills, 'alpha', 'SKILL.md'), 'utf8')).toContain('First.');
    expect(race.fs.existsSync(join(skills, 'beta'))).toBe(false);
    expect(race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lock);
  });

  it('the temp folder swapped for a link between its making and the first write: refused, nothing written where it points', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const elsewhere = join(p.dir, 'elsewhere');
    race.fs.mkdirSync(elsewhere);
    race.onLstat = (path) => {
      if (!/\.skills-catalog-staging\/install-[^/]+$/.test(path)) return;
      race.onLstat = undefined;
      race.fs.renameSync(path, join(p.dir, 'moved-tmp'));
      race.fs.symlinkSync(elsewhere, path);
    };
    let r: unknown;
    try {
      r = await install(ctxFor(p), { name: 'alpha', target: 'project' }).catch((e: unknown) => e);
    } finally {
      clearHooks();
    }
    expect(codeOf(r)).toBe('target_changed');
    expect(race.fs.readdirSync(elsewhere)).toEqual([]);
    expect(race.fs.existsSync(join(p.dir, 'project', '.claude', 'skills', 'alpha'))).toBe(false);
  });

  it('the staging folder ignores everything in it for git, and is removed with its .gitignore when nothing else is left', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const staging = stagingDir(p);
    let seen: string | undefined;
    race.onRename = (from) => {
      if (from.startsWith(staging) && seen === undefined) seen = race.fs.readFileSync(join(staging, '.gitignore'), 'utf8');
    };
    try {
      await install(ctxFor(p), { name: 'alpha', target: 'project' });
    } finally {
      clearHooks();
    }
    expect(seen).toBe('*\n');
    expect(race.fs.existsSync(staging)).toBe(false);
  });
});

// The temp folder is checked before each file and again just before it's moved in: a folder swapped in for it is never
// moved into the skills folder. Once a file was written, the files may sit wherever the temp folder was moved, so the
// refusal says a copy may be elsewhere; its path is the temp folder, the first path that failed (contract §4.5).
describe('the temp folder is checked before every use', () => {
  const tmpPattern = /\.skills-catalog-staging\/install-[^/]+$/;
  // Moves the temp folder away and puts a folder of someone else's making, holding `planted`, in its place.
  const swapTmp = (p: Place, tmp: string) => {
    race.fs.renameSync(tmp, join(p.dir, 'moved-tmp'));
    race.fs.mkdirSync(tmp);
    race.fs.writeFileSync(join(tmp, 'planted'), 'not the skill\n');
  };
  // Records whether a folder holding `planted` ever lands at the skill's path.
  const watchDest = (dest: string) => {
    const seen = { planted: false };
    race.afterRename = (_from, to) => {
      if (to === dest && race.fs.existsSync(join(dest, 'planted'))) seen.planted = true;
    };
    return seen;
  };

  it('swapped after the last file is written, before it is moved in: never moved in, refused, the copy may be elsewhere', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const dest = join(p.dir, 'project', '.claude', 'skills', 'alpha');
    let tmp: string | undefined;
    race.onLstat = (path) => {
      if (tmpPattern.test(path)) tmp ??= path;
      if (path !== dest || !tmp || !race.fs.existsSync(join(tmp, 'SKILL.md'))) return;
      race.onLstat = undefined;
      swapTmp(p, tmp);
    };
    const seen = watchDest(dest);
    let r: unknown;
    try {
      r = await install(ctxFor(p), { name: 'alpha', target: 'project' }).catch((e: unknown) => e);
    } finally {
      clearHooks();
    }
    expect(seen.planted).toBe(false);
    expect([codeOf(r), refused(r).data]).toEqual(['target_changed', { path: tmp, temp: true, elsewhere: true }]);
    expect(race.fs.existsSync(dest)).toBe(false);
  });

  it('swapped as the installed copy is moved aside: never moved in, the installed copy is back, refused', async () => {
    const p = place();
    await publish(p, 'alpha', 'First.\n');
    await install(ctxFor(p), { name: 'alpha', target: 'project' });
    await publish(p, 'alpha', 'Second.\n');
    const dest = join(p.dir, 'project', '.claude', 'skills', 'alpha');
    let tmp: string | undefined;
    race.onLstat = (path) => {
      if (tmpPattern.test(path)) tmp ??= path;
    };
    race.onRename = (from) => {
      if (from !== dest || !tmp) return;
      race.onRename = undefined;
      swapTmp(p, tmp);
    };
    const seen = watchDest(dest);
    let r: unknown;
    try {
      r = await install(ctxFor(p), { name: 'alpha', version: 2, target: 'project' }).catch((e: unknown) => e);
    } finally {
      clearHooks();
    }
    expect(seen.planted).toBe(false);
    expect([codeOf(r), refused(r).data]).toEqual(['target_changed', { path: tmp, temp: true, elsewhere: true }]);
    expect(race.fs.readFileSync(join(dest, 'SKILL.md'), 'utf8')).toContain('First.');
  });

  it('swapped between two files: refused before the second, the copy may be elsewhere; swapped before any file: not elsewhere', async () => {
    for (const [at, elsewhere] of [[1, true], [0, false]] as const) {
      const p = place();
      const c = await open(p);
      try {
        await c.publish(request('alpha', [{ path: 'SKILL.md', text: skillMd('alpha', 'The alpha skill.') }, { path: 'zz.md', text: 'Last.\n' }]), actAs('ana'));
      } finally {
        c.close();
      }
      let tmp: string | undefined;
      let checks = 0;
      // The temp folder's checks: its identity once made, then one before each file.
      race.onLstat = (path) => {
        if (!tmpPattern.test(path)) return;
        tmp ??= path;
        if (checks++ !== at + 1) return;
        race.onLstat = undefined;
        swapTmp(p, tmp);
      };
      let r: unknown;
      try {
        r = await install(ctxFor(p), { name: 'alpha', target: 'project' }).catch((e: unknown) => e);
      } finally {
        clearHooks();
      }
      expect([at, codeOf(r), refused(r).data]).toEqual([at, 'target_changed', { path: tmp, temp: true, ...(elsewhere ? { elsewhere: true } : {}) }]);
      expect(race.fs.readdirSync(join(p.dir, 'moved-tmp'))).toEqual(elsewhere ? ['SKILL.md'] : []);
      expect(race.fs.existsSync(join(p.dir, 'project', '.claude', 'skills', 'alpha'))).toBe(false);
    }
  });
});

// Inode numbers past 2^53 (overlay and some network file systems): compared exactly, and kept in the lock as decimal
// strings, so a replaced copy there is deleted as any other.
describe('identities past 2^53', () => {
  it('are stored as decimal strings, read back exactly, and the replaced copy is deleted as usual, never piling up in staging', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const claude = join(p.dir, 'project', '.claude');
    const big = 2n ** 60n;
    race.stats = (at, s) => (at.startsWith(claude) ? ({ ino: BigInt(s.ino) + big } as unknown as Partial<import('node:fs').Stats>) : undefined);
    try {
      const ctx = ctxFor(p);
      await install(ctx, { name: 'alpha', target: 'project' });
      const dest = join(claude, 'skills', 'alpha');
      const copy = JSON.parse(race.fs.readFileSync(join(p.home, 'lock.json'), 'utf8')).skills[dest].copy;
      expect(copy.ino).toBe((BigInt(race.fs.lstatSync(dest).ino) + big).toString());
      expect(typeof copy.dev).toBe('number');
      await publish(p, 'alpha', 'Second, markdown only.\n');
      const r = await update(ctx, {});
      expect(r.text).toContain(S.format(S.word('update.updated'), { name: 'alpha', from: 1, to: 2, changes: '"SKILL.md" changed' }));
      expect(r.text).not.toContain('staging');
      expect(stagingEntries(p)).toEqual([]);
      expect((await MACHINE_RUNS['list_installed_skills']!(ctx, {})).text).toContain('alpha');
    } finally {
      clearHooks();
    }
  });
});
