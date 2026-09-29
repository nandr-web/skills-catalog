// publish_skill_to_catalog (contract §3): a folder becomes a new version in two steps, so the person sees what will be
// published before it is. Step 1 lists what it would send and skip, stores nothing and gives a confirm tied to the
// folder's fingerprint; step 2 with that confirm publishes, unless the folder or the catalog changed in between. The
// folder is read as regular files only (golden/skills.yaml hostile), and the ignore list is skipped and reported.
import { chmodSync, linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { CatalogError, Surface, actAs } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
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
        skip: ['".DS_Store"', '".env"', '".git/config"', '"id_fake"', '"key.pem"'].join(', '), review: '', folder: dir, confirm,
      }),
    );
    expect(preview.result).toBe(S.doc.log.result.publish.preview);
    expect(await versionsOf(p, 'ignore-list')).toBe(0);

    const done = await publish(ctx, { folder: dir, message: 'First version.', confirm });
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
    expect(again.text).toBe(S.format(S.word('publish.identical'), { folder: dir, name: 'ignore-list', latest: 1 }));
  });

  it('refuses at step 2 when the folder changed since the preview, or another version landed: nothing stored', async () => {
    const p = place();
    const dir = folder(p, 'moving', { 'SKILL.md': skillMd('moving', 'Changes between the steps.') });
    const ctx = ctxFor(p, 'ana');
    const confirm = confirmOf((await publish(ctx, { folder: dir })).text)!;
    writeFileSync(join(dir, 'notes.md'), 'added after the preview\n');
    expect((await refusal(() => publish(ctx, { folder: dir, confirm }))).toJSON()).toMatchObject({ code: 'conflict', name: 'moving', folder: dir });
    expect(await versionsOf(p, 'moving')).toBe(0);

    const confirm2 = confirmOf((await publish(ctx, { folder: dir })).text)!;
    const c = await open(p);
    await c.publish(request('moving', [{ path: 'SKILL.md', text: skillMd('moving', 'Published in between.') }]), actAs('ana'));
    c.close();
    const e = await refusal(() => publish(ctx, { folder: dir, confirm: confirm2 }));
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
