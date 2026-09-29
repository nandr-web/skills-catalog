// publish_skill_to_catalog (contract §3): a folder becomes a new version in two steps, so the person sees what will be
// published before it is. Step 1 lists what it would send and skip, stores nothing and gives a confirm tied to the
// folder's fingerprint; step 2 with that confirm publishes, unless the folder or the catalog changed in between. The
// folder is read as regular files only (golden/skills.yaml hostile), and the ignore list is skipped and reported.
import { chmodSync, linkSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { CatalogError, Surface, actAs } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { readFolder } from '../src/machine/publish-folder.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Surface.load();
const SENTINEL = 'QA-SENTINEL-publish-folder';
const publish = MACHINE_RUNS['publish_skill_to_catalog']!;

function folder(p: Place, name: string, files: Record<string, string | { text: string; mode?: number }>): string {
  const dir = join(p.dir, 'work', name);
  for (const [path, f] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof f === 'string' ? f : f.text);
    if (typeof f !== 'string' && f.mode) chmodSync(full, f.mode);
  }
  return dir;
}

function ctxFor(p: Place, as: string | undefined, face: 'mcp' | 'cli' = 'mcp'): Context {
  const settings = settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, ...(as ? { SKILLS_AS: as } : {}) });
  return contextFor(settings, S, face).ctx;
}

const refusal = async (fn: () => Promise<unknown>): Promise<CatalogError> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('expected a CatalogError');
};

const confirmOf = (text: string) => /confirm "([^"]+)"/.exec(text)?.[1];
// Step 2's values, as the preview gives them.
const step2Of = (text: string) => {
  const m = /confirm "([^"]*)", name "([^"]*)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(text)!;
  return { confirm: m[1]!, name: m[2]!, version: Number(m[3]), files: Number(m[4]), flags: JSON.parse(m[5]!) as string[] };
};
const versionsOf = async (p: Place, name: string) => {
  const c = await open(p);
  try {
    return (await c.versions({ name })).latest;
  } catch (e) {
    if (e instanceof CatalogError && e.code === 'not_found') return 0;
    throw e;
  } finally {
    c.close();
  }
};

describe('publish a folder, in two steps (contract §3)', () => {
  it('step 1 lists what it sends and skips (the ignore list), stores nothing; step 2 with the confirm publishes just that', async () => {
    const p = place();
    const dir = folder(p, 'ignore-list', {
      'SKILL.md': skillMd('ignore-list', 'Folder holds files that must not be published.'),
      '.env': `QA_SENTINEL=${SENTINEL}\n`,
      '.git/config': '[core]\n',
      id_fake: `${SENTINEL}\n`,
      'key.pem': `${SENTINEL}\n`,
      '.DS_Store': 'x',
    });
    const ctx = ctxFor(p, 'ana');
    const preview = await publish(ctx, { folder: dir, message: 'First version.' });
    const confirm = confirmOf(preview.text)!;
    expect(preview.text).toBe(
      S.format(S.word('publish.preview'), {
        name: 'ignore-list', version: 1, change: S.word('publish.new_skill'), n_send: 1, send: '"SKILL.md"', n_skip: 5,
        skip: ['".DS_Store"', '".env"', '".git/"', '"id_fake"', '"key.pem"'].join(', '), review: '', folder: JSON.stringify(dir), confirm, flags: '[]',
      }),
    );
    expect(preview.result).toBe(S.doc.log.result.publish.preview);
    expect(await versionsOf(p, 'ignore-list')).toBe(0);

    const done = await publish(ctx, { folder: dir, message: 'First version.', ...step2Of(preview.text) });
    expect(done.text).toBe(S.format(S.word('publish.published'), { name: 'ignore-list', version: 1 }));
    expect(done.target).toBe('ignore-list v1');
    const c = await open(p);
    try {
      const got = await c.fetch({ name: 'ignore-list', version: 1 });
      expect(got.files.map((f) => f.path)).toEqual(['SKILL.md']);
      expect(JSON.stringify(got)).not.toContain(Buffer.from(SENTINEL).toString('base64').slice(0, 12));
    } finally {
      c.close();
    }
    for (const t of [preview.text, done.text]) expect(t).not.toContain(SENTINEL);
    // The same folder again: nothing new.
    const again = await publish(ctx, { folder: dir });
    expect(again.text).toBe(S.format(S.word('publish.identical'), { folder: JSON.stringify(dir), name: 'ignore-list', latest: 1 }));
  });

  it('refuses at step 2 when the folder changed since the preview, or another version landed: nothing stored', async () => {
    const p = place();
    const dir = folder(p, 'moving', { 'SKILL.md': skillMd('moving', 'Changes between the steps.') });
    const ctx = ctxFor(p, 'ana');
    const step2 = step2Of((await publish(ctx, { folder: dir })).text);
    writeFileSync(join(dir, 'notes.md'), 'added after the preview\n');
    expect((await refusal(() => publish(ctx, { folder: dir, ...step2 }))).toJSON()).toMatchObject({ code: 'conflict', name: 'moving', folder: realpathSync(dir) });
    expect(await versionsOf(p, 'moving')).toBe(0);

    const step2b = step2Of((await publish(ctx, { folder: dir })).text);
    const c = await open(p);
    await c.publish(request('moving', [{ path: 'SKILL.md', text: skillMd('moving', 'Published in between.') }]), actAs('ana'));
    c.close();
    const e = await refusal(() => publish(ctx, { folder: dir, ...step2b }));
    expect(e.toJSON()).toMatchObject({ code: 'conflict', name: 'moving', latest: 1 });
    expect(e.data['folder']).toBeUndefined();
    expect(await versionsOf(p, 'moving')).toBe(1);
  });

  it('refuses a suspected secret at step 1, naming the file and line; only the CLI face takes the person\'s override', async () => {
    const p = place();
    const key = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const dir = folder(p, 'keys', { 'SKILL.md': skillMd('keys', 'Calls an API.'), 'scripts/call.sh': { text: `#!/bin/sh\ncurl -H "Authorization: ${key}" x\n`, mode: 0o755 } });
    const e = await refusal(() => publish(ctxFor(p, 'ana'), { folder: dir }));
    expect(e.toJSON()).toEqual({ code: 'secret_suspected', path: 'scripts/call.sh', line: 2, kind: 'github_token', folder: dir });
    expect((await refusal(() => publish(ctxFor(p, 'ana'), { folder: dir, allow_suspected_secrets: true }))).data).toMatchObject({ field: 'allow_suspected_secrets', why: 'unknown_field' });
    const preview = await publish(ctxFor(p, 'ana', 'cli'), { folder: dir, allow_suspected_secrets: true });
    expect(preview.text).not.toContain(key);
    expect(confirmOf(preview.text)).toBeTruthy();
  });

  it('reads regular files only: a link out, a hard link and a fifo are refused, and what they point at never leaks', async () => {
    const p = place();
    const outside = join(p.dir, 'outside', 'id_fake');
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(outside, `${SENTINEL}\n`);
    const cases: [string, (dir: string) => void, string][] = [
      ['symlink-out', (dir) => symlinkSync(outside, join(dir, 'secrets')), 'secrets'],
      ['hardlink', (dir) => linkSync(outside, join(dir, 'linked.md')), 'linked.md'],
      ['special-file', (dir) => execFileSync('mkfifo', [join(dir, 'pipe')]), 'pipe'],
    ];
    for (const [name, plant, path] of cases) {
      const dir = folder(p, name, { 'SKILL.md': skillMd(name, 'Holds something that is not a regular file.') });
      plant(dir);
      const e = await refusal(() => publish(ctxFor(p, 'ana'), { folder: dir }));
      expect([e.code, e.data['path']], name).toEqual(['invalid_path', path]);
      expect(JSON.stringify(e.toJSON()), name).not.toContain(SENTINEL);
    }
  });

  it('refuses another developer\'s skill at the preview, and a folder with no SKILL.md in the manifest\'s words', async () => {
    const p = place();
    const c = await open(p);
    await c.publish(request('owned', [{ path: 'SKILL.md', text: skillMd('owned', 'Belongs to ana.') }]), actAs('ana'));
    c.close();
    const dir = folder(p, 'owned', { 'SKILL.md': skillMd('owned', 'Bob tries to publish over it.') });
    expect((await refusal(() => publish(ctxFor(p, 'bob'), { folder: dir }))).toJSON()).toMatchObject({ code: 'not_owner', name: 'owned', owners: ['ana'] });
    const empty = folder(p, 'empty', { 'notes.md': 'no skill here\n' });
    const e = await refusal(() => publish(ctxFor(p, 'ana'), { folder: empty }));
    expect(e.toJSON()).toMatchObject({ code: 'invalid_manifest', problem: 'missing', folder: empty });
  });
});

// Contract §4.2, "its target is never read": what is read is the file that was checked. A file or folder swapped between
// its check and its read (by the person's other programs, or anyone who can write there) is refused, never followed.
describe('the folder is read as it was checked (a swap in between is refused)', () => {
  const outsideSecret = (p: Place) => {
    const f = join(p.dir, 'outside', 'id_fake');
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, `${SENTINEL}\n`);
    return f;
  };
  const refusedRead = (fn: () => unknown): CatalogError => {
    try {
      fn();
    } catch (e) {
      if (e instanceof CatalogError) return e;
      throw e;
    }
    throw new Error('expected a CatalogError');
  };

  const swaps: [string, (full: string, p: Place) => void][] = [
    ['a link out', (full, p) => { rmSync(full); symlinkSync(outsideSecret(p), full); }],
    ['another regular file', (full) => { writeFileSync(`${full}.new`, 'swapped in\n'); renameSync(`${full}.new`, full); }],   // both exist at once: a new inode
    ['a hard link to a file outside', (full, p) => { rmSync(full); linkSync(outsideSecret(p), full); }],
    ['a fifo (the read never blocks)', (full) => { rmSync(full); execFileSync('mkfifo', [full]); }],
  ];
  for (const [what, swap] of swaps) {
    it(`a file swapped for ${what} after its check is invalid_path {why: not_regular_file}, and nothing of it leaks`, () => {
      const p = place();
      const dir = folder(p, 'swapped', { 'SKILL.md': skillMd('swapped', 'A file changes under the reader.'), 'notes.md': 'checked\n' });
      const e = refusedRead(() => readFolder(dir, { beforeRead: (full) => { if (full.endsWith('notes.md')) swap(full, p); } }));
      expect(e.toJSON()).toEqual({ code: 'invalid_path', path: 'notes.md', why: 'not_regular_file' });
      expect(JSON.stringify(e.toJSON())).not.toContain(SENTINEL);
    });
  }

  it('a folder swapped for a link after its check is refused, and nothing under the link is listed or read', () => {
    const p = place();
    const elsewhere = join(p.dir, 'outside', 'folder');
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, 'id_fake.md'), `${SENTINEL}\n`);
    const dir = folder(p, 'swapped-folder', { 'SKILL.md': skillMd('swapped-folder', 'A folder changes under the reader.'), 'docs/a.md': 'a\n' });
    const e = refusedRead(() => readFolder(dir, {
      beforeList: (d) => { if (d.endsWith('docs')) { renameSync(d, `${d}.old`); symlinkSync(elsewhere, d); } },
    }));
    expect(e.toJSON()).toEqual({ code: 'invalid_path', path: 'docs', why: 'not_regular_file' });
    expect(JSON.stringify(e.toJSON())).not.toContain(SENTINEL);
  });
});
