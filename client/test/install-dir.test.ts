// SKILLS_INSTALL_DIR (contract §8): the user target's skills land there instead of <assistant home>/.claude/skills. It
// must be absolute; its parent takes .claude's checks and the folder above that takes the private-folder test the folder
// above .claude gets, so nobody else can swap the parent. The project target is unaffected.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, Words, actAs } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { pendingHold } from '../src/machine/installer.ts';
import { contextFor, type Context } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Words.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const ctxFor = (p: Place, installDir: string): Context =>
  contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed, SKILLS_INSTALL_DIR: installDir }, join(p.dir, 'project')), S, 'mcp').ctx;
async function published(): Promise<Place> {
  const p = place();
  const c = await open(p);
  try {
    await c.publish(request('alpha', [{ path: 'SKILL.md', text: skillMd('alpha', 'The alpha skill.') }]), actAs('ana'));
  } finally {
    c.close();
  }
  return p;
}
// Every file under a folder, by path, with its bytes.
const folderBytes = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir, { recursive: true }).map(String).sort().map((f) => [f, statSync(join(dir, f)).isFile() ? readFileSync(join(dir, f)).toString('base64') : '/']));
const refusal = (f: () => Promise<unknown>) => f().then(() => undefined, (e: unknown) => e as CatalogError);

describe('SKILLS_INSTALL_DIR', () => {
  // A project install looks in the user target too (a same-name skill there would shadow it), so it can't go on without a
  // usable user folder either; nothing is made anywhere.
  it('a relative one is refused (nothing made), for the project target too, which checks the user target for its name', async () => {
    const p = await published();
    const ctx = ctxFor(p, 'relative/skills');
    mkdirSync(join(p.dir, 'project'), { recursive: true });
    for (const target of ['user', 'project'] as const) {
      const e = await refusal(() => install(ctx, { name: 'alpha', target }));
      expect([target, e?.code, e?.data]).toEqual([target, 'invalid_request', { field: 'SKILLS_INSTALL_DIR', why: 'not_absolute' }]);
    }
    expect(existsSync(join(p.dir, 'project', 'relative'))).toBe(false);
    expect(existsSync(join(p.dir, 'project', '.claude'))).toBe(false);
  });

  // Refused before anything is read or written: the lock and config aren't read (a damaged lock would be named first) and
  // the catalog isn't opened (its folder keeps every byte), and a relative path is never resolved against the working folder.
  it('a relative one is refused by every call that uses the installed skills, before the lock, the config or the catalog is read', async () => {
    const p = await published();
    const ctx = ctxFor(p, 'relative/skills');
    mkdirSync(p.home, { recursive: true });
    writeFileSync(join(p.home, 'lock.json'), '{');
    const catalogBefore = folderBytes(p.catalogDir);
    const calls: [string, () => Promise<unknown>][] = [
      ['install', () => install(ctx, { name: 'alpha' })],
      ['update', () => MACHINE_RUNS['update_installed_skills']!(ctx, {})],
      ['accept', () => MACHINE_RUNS['accept_held_update']!(ctx, { name: 'alpha', target: 'user', version: 1, flags: [], confirm: 'x' })],
      ['list', () => MACHINE_RUNS['list_installed_skills']!(ctx, {})],
      ['policy', () => MACHINE_RUNS['set_skill_update_policy']!(ctx, { name: 'alpha', policy: 'pin' })],
      ['pending hold', () => pendingHold(ctx, 'alpha')],
    ];
    for (const [what, call] of calls) {
      const e = await refusal(call);
      expect([what, e?.code, e?.data]).toEqual([what, 'invalid_request', { field: 'SKILLS_INSTALL_DIR', why: 'not_absolute' }]);
    }
    expect(folderBytes(p.catalogDir)).toEqual(catalogBefore);
    expect(existsSync('relative')).toBe(false);
  });

  it('the folder above its parent writable by others is refused as not private (not the assistant home), nothing made', async () => {
    const p = await published();
    const open_ = join(p.dir, 'open');
    mkdirSync(open_, { recursive: true });
    chmodSync(open_, 0o777);
    const e = await refusal(() => install(ctxFor(p, join(open_, 'x', 'skills')), { name: 'alpha' }));
    expect(e?.code).toBe('target_not_private');
    expect(e?.data).toMatchObject({ path: open_, target: 'user' });
    expect(e?.data['home']).toBeUndefined();
    expect(existsSync(join(open_, 'x'))).toBe(false);
  });

  it('a folder on the way that can\'t be made is target_unavailable, never named as the assistant home', async () => {
    const p = await published();
    const file = join(p.dir, 'a-file');
    writeFileSync(file, 'not a folder');
    // The folder above the install folder's parent is the one that can't be made.
    const e = await refusal(() => install(ctxFor(p, join(file, 'x', 'y', 'skills')), { name: 'alpha' }));
    expect(e?.code).toBe('target_unavailable');
    expect(e?.data['path']).toBe(join(file, 'x'));
    expect(e?.data['home']).toBeUndefined();
  });
});
