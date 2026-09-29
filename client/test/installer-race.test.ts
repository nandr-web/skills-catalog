// A link swapped in after the installer's own folder checks, at the moment it moves the installed copy out of the way
// (the security review's race). The installer deletes only the folder it moved, and only if it is still the one it
// checked; otherwise it puts it back, refuses with target_symlink and deletes nothing.
import { mkdirSync, readFileSync, readdirSync, renameSync as realRename, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Surface, actAs, type Catalog } from '@skills-catalog/core';
import { describe, expect, it, vi } from 'vitest';
import { contextFor } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

// Every renameSync the installer makes passes through `race.before` first (the test's swap), once.
const race = vi.hoisted(() => ({ before: undefined as undefined | ((from: string, to: string) => void) }));
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  const renameSync = (from: string, to: string) => {
    const swap = race.before;
    if (swap) swap(String(from), String(to));
    return fs.renameSync(from, to);
  };
  return { ...fs, renameSync, default: { ...fs, renameSync } };
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

describe('a link swapped in while the installed copy is moved aside (the security review\'s race)', () => {
  it('puts back what it moved, refuses, and deletes nothing: the canary stays, the lock is unchanged', async () => {
    const p = place();
    await publish(p, 'alpha', 'Body.\n');
    const ctx = ctxFor(p);
    await install(ctx, { name: 'alpha', target: 'project' });
    await publish(p, 'alpha', 'Second, markdown only.\n');
    const skills = join(p.dir, 'project', '.claude', 'skills');
    const dest = join(skills, 'alpha');
    const victim = join(p.dir, 'victim');
    mkdirSync(join(victim, 'alpha'), { recursive: true });
    writeFileSync(join(victim, 'alpha', 'canary'), 'keep me\n');
    const lockBefore = readFileSync(join(p.home, 'lock.json'), 'utf8');

    // Right when the installed copy is moved out of the way, .claude/skills becomes a link to victim/.
    race.before = (from) => {
      if (from !== dest) return;
      race.before = undefined;
      realRename(skills, join(p.dir, 'aside'));
      symlinkSync(victim, skills);
    };
    try {
      const r = await update(ctx, {}).catch((e: unknown) => e);
      expect((r as { code?: string }).code).toBe('target_symlink');
    } finally {
      race.before = undefined;
    }
    expect(readFileSync(join(victim, 'alpha', 'canary'), 'utf8')).toBe('keep me\n');
    expect(readdirSync(victim)).toEqual(['alpha']);
    expect(readdirSync(join(victim, 'alpha'))).toEqual(['canary']);
    expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);
    // The real installed copy was never touched: it's still where the swap moved the folder.
    expect(readFileSync(join(p.dir, 'aside', 'alpha', 'SKILL.md'), 'utf8')).toBe(skillMd('alpha', 'The alpha skill.', 'Body.\n'));
  });
});
