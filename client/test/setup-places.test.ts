// Whose files and folders setup works in (setup build notes §1 folders, §3 "First, whose files", §9's config moved): all
// read and checked before anything is made, so each refusal leaves every folder as it was.
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPlaces } from '../src/machine/setup-places.ts';
import { race } from './race-fs.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
afterEach(() => {
  race.stats = undefined;
});

const ID = '0123456789abcdef0123456789abcdef';
const me = process.getuid!();

/** A sandbox with the assistant home made (0700) and, unless `skillsHome` is false, the skills home too. */
function homes({ skillsHome = true } = {}) {
  const dir = sandbox();
  const A = join(dir, 'home');
  const H = join(dir, 'skills-home');
  mkdirSync(A, { mode: 0o700 });
  if (skillsHome) mkdirSync(H, { mode: 0o700 });
  return { dir, A, H, input: { assistantHome: A, skillsHome: H, env: {} as Record<string, string>, uid: me } };
}
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof CatalogError) return { code: e.code, data: e.data };
    throw e;
  }
  return undefined;
};
const listing = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

describe('where setup works, checked before anything is made', () => {
  it('a usable pair of homes: the places, what\'s missing, and no record yet', () => {
    const { A, H, input } = homes();
    const r = checkPlaces(input);
    expect(r.places).toEqual({
      assistantHome: A,
      claudeDir: join(A, '.claude'),
      claudeJson: join(A, '.claude.json'),
      settingsJson: join(A, '.claude', 'settings.json'),
      skillsHome: H,
      backups: join(H, 'backups'),
      record: join(H, 'setup-record.json'),
      lock: join(H, 'setup.lock'),
    });
    expect(r.missing).toEqual({ claudeDir: true, skillsHome: false, backups: true });
    expect(r.record).toBeUndefined();
  });

  it('CLAUDE_CONFIG_DIR set without SKILLS_ASSISTANT_HOME: assistant_config_elsewhere, before anything else', () => {
    const { input } = homes();
    expect(refusal(() => checkPlaces({ ...input, env: { CLAUDE_CONFIG_DIR: '/c' }, uid: 0 }))).toEqual({ code: 'assistant_config_elsewhere', data: { setting: 'CLAUDE_CONFIG_DIR' } });
    expect(refusal(() => checkPlaces({ ...input, env: { CLAUDE_CONFIG_DIR: '/c', SKILLS_ASSISTANT_HOME: input.assistantHome } }))).toBeUndefined();
  });

  it('root with SUDO_USER set, or a home or skills home another user owns: target_not_private, own false, nothing made', () => {
    const { dir, A, H, input } = homes({ skillsHome: false });
    const before = listing(dir);
    expect(refusal(() => checkPlaces({ ...input, env: { SUDO_USER: 'person' }, uid: 0 }))).toEqual({ code: 'target_not_private', data: { path: A, own: false } });
    // Refused outright, even where every folder is root's own: root is never the one setup writes for.
    race.stats = () => ({ uid: 0 });
    expect(refusal(() => checkPlaces({ ...input, env: { SUDO_USER: 'person' }, uid: 0 }))).toEqual({ code: 'target_not_private', data: { path: A, own: false } });
    race.stats = (p) => (p === A ? { uid: me + 1 } : undefined);
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_not_private', data: { path: A, own: false } });
    // A missing skills home: its parent is the one to own.
    race.stats = (p) => (p === dir ? { uid: me + 1 } : undefined);
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_not_private', data: { path: dir, own: false } });
    mkdirSync(H, { mode: 0o700 });
    race.stats = (p) => (p === H ? { uid: me + 1 } : undefined);
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_not_private', data: { path: H, own: false } });
    race.stats = undefined;
    expect(listing(dir)).toEqual([...before, 'skills-home'].sort());
  });

  it('a skills home or assistant home others can write: target_not_private (the assistant home named as the home)', () => {
    const { A, H, input } = homes();
    chmodSync(H, 0o777);
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_not_private', data: { path: H, own: true } });
    chmodSync(H, 0o700);
    chmodSync(A, 0o722);
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_not_private', data: { path: A, home: true, own: true } });
  });

  it('a home setup can\'t write in: target_unavailable', () => {
    const { A, input } = homes();
    chmodSync(A, 0o500);
    try {
      expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_unavailable', data: { path: A } });
    } finally {
      chmodSync(A, 0o700);
    }
  });

  it('the assistant home itself may be a link; .claude and backups must be real, private folders', () => {
    const { dir, A, H, input } = homes();
    const linked = join(dir, 'linked-home');
    symlinkSync(A, linked);
    expect(checkPlaces({ ...input, assistantHome: linked }).places.claudeJson).toBe(join(A, '.claude.json')); // its real folder

    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(A, '.claude'));
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_symlink', data: { path: join(A, '.claude') } });
    expect(H).toBe(input.skillsHome);
  });

  it('.claude: a file in its place, or others can write it, is refused; a private one is used as it is', () => {
    const { A, input } = homes();
    writeFileSync(join(A, '.claude'), '');
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'exists_untracked', data: { path: join(A, '.claude') } });
    const { A: A2, input: input2 } = homes();
    mkdirSync(join(A2, '.claude'), { mode: 0o777 });
    chmodSync(join(A2, '.claude'), 0o777);
    expect(refusal(() => checkPlaces(input2))).toEqual({ code: 'target_not_private', data: { path: join(A2, '.claude'), own: true } });
    chmodSync(join(A2, '.claude'), 0o700);
    expect(checkPlaces(input2).missing.claudeDir).toBe(false);
  });

  it('the backups folder: a link or a shared folder refuses before anything is written', () => {
    const { dir, H, input } = homes();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere, { mode: 0o700 });
    symlinkSync(elsewhere, join(H, 'backups'));
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_symlink', data: { path: join(H, 'backups') } });
    const { H: H2, input: input2 } = homes();
    mkdirSync(join(H2, 'backups'));
    chmodSync(join(H2, 'backups'), 0o777);
    expect(refusal(() => checkPlaces(input2))).toEqual({ code: 'target_not_private', data: { path: join(H2, 'backups'), own: true } });
  });

  it('the record: read when usable; a link, not JSON, the wrong shape or naming paths elsewhere is invalid_local_file', () => {
    const { dir, H, input } = homes();
    const record = join(H, 'setup-record.json');
    const good = { version: 1, setup_id: ID, entries: [], created_files: [], backups: [] };
    writeFileSync(record, JSON.stringify(good), { mode: 0o600 });
    expect(checkPlaces(input).record).toEqual(good);
    const bad = (why: string) => ({ code: 'invalid_local_file', data: { file: 'setup-record.json', why, path: record } });
    writeFileSync(record, 'not json');
    expect(refusal(() => checkPlaces(input))).toEqual(bad('not_json'));
    writeFileSync(record, JSON.stringify({ ...good, extra: 1 }));
    expect(refusal(() => checkPlaces(input))).toEqual(bad('wrong_shape'));
    const other = { kind: 'allow_rule', file: join(dir, 'other', 'settings.json'), value: 'x', state: 'written', was_there: false };
    writeFileSync(record, JSON.stringify({ ...good, entries: [other] }));
    expect(refusal(() => checkPlaces(input))).toEqual(bad('wrong_shape'));
    writeFileSync(join(dir, 'outside.json'), JSON.stringify(good));
    writeFileSync(record, '');
    const { rmSync } = race.fs;
    rmSync(record);
    symlinkSync(join(dir, 'outside.json'), record);
    expect(refusal(() => checkPlaces(input))).toEqual(bad('link'));
  });

  it('the record\'s allow rules must be rules setup writes: any other text is the wrong shape, so teardown never removes it', () => {
    const { A, H, input } = homes();
    const record = join(H, 'setup-record.json');
    const rule = (value: string) => ({ kind: 'allow_rule', file: join(A, '.claude', 'settings.json'), value, state: 'written', was_there: false });
    const good = { version: 1, setup_id: ID, entries: [rule('Bash(skills-catalog update)')], created_files: [], backups: [] };
    const allowed = ['Bash(skills-catalog update)'];
    writeFileSync(record, JSON.stringify(good), { mode: 0o600 });
    expect(checkPlaces({ ...input, allowed }).record).toEqual(good);
    writeFileSync(record, JSON.stringify({ ...good, entries: [rule('Bash(rm -rf *)')] }));
    expect(refusal(() => checkPlaces({ ...input, allowed }))).toEqual({ code: 'invalid_local_file', data: { file: 'setup-record.json', why: 'wrong_shape', path: record } });
  });

  it('a skills home that is a link is target_symlink; the folders above each home must be the person\'s or root\'s, and only written by others with the sticky bit', () => {
    const { dir, A, H, input } = homes({ skillsHome: false });
    const real = join(dir, 'real-skills-home');
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, H);
    expect(refusal(() => checkPlaces(input))).toEqual({ code: 'target_symlink', data: { path: H } });
    const t = homes();
    // Another user's folder above the assistant home: they could rename the home and put their own in its place.
    race.stats = (p) => (p === t.dir ? { uid: me + 1 } : undefined);
    expect(refusal(() => checkPlaces(t.input))).toEqual({ code: 'target_not_private', data: { path: t.dir, own: false } });
    // Written by everyone, without the sticky bit: refused; with it (as /tmp), it passes.
    race.stats = (p) => (p === t.dir ? { mode: 0o40777 } : undefined);
    expect(refusal(() => checkPlaces(t.input))).toEqual({ code: 'target_not_private', data: { path: t.dir, own: true } });
    race.stats = (p) => (p === t.dir ? { mode: 0o41777 } : undefined);
    expect(refusal(() => checkPlaces(t.input))).toBeUndefined();
    // Root's folder above passes.
    race.stats = (p) => (p === t.dir ? { uid: 0 } : undefined);
    expect(refusal(() => checkPlaces(t.input))).toBeUndefined();
    void A;
  });
});
