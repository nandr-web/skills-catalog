// Publishing from the command line (P2.5, P5.4, P16.6; contract §3): the same one operation as the assistant's tool,
// publish_skill_to_catalog, in its two steps. A person at a terminal runs `publish <folder>`: the preview's lists, then
// "Publish ...? (y/N)", and the publish on a yes, in one process. With no terminal and none of step 2's values, only the
// preview runs (nothing stored) and the exact step-2 command is printed (exit 3: it needs the person's yes); that command
// publishes as printed. A malformed skill is refused in the person's words, nothing stored.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, renderError, type Catalog } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { cli, lastLogLine, S } from './cli-io.ts';
import { open, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

function folder(p: Place, name: string, body = 'Body.\n'): string {
  const dir = join(p.dir, 'work', name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name, `The ${name} skill.`, body));
  writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 });
  writeFileSync(join(dir, '.env'), 'SECRET=1\n');
  return dir;
}
async function versionsOf(p: Place, name: string): Promise<{ version: number; publisher: string }[]> {
  const c: Catalog = await open(p);
  try {
    return (await c.versions({ name })).versions.map((v) => ({ version: v.version, publisher: v.publisher }));
  } catch (e) {
    if (e instanceof CatalogError && e.code === 'not_found') return [];
    throw e;
  } finally {
    c.close();
  }
}
const AS = { SKILLS_AS: 'ana' };

describe('publish <folder> at a terminal (the person)', () => {
  it('shows what it would send and skip, asks, and publishes on a yes', async () => {
    const p = place();
    const dir = folder(p, 'notes-draft');
    const r = await cli(p, ['publish', dir], { tty: true, answers: ['y'], env: AS });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('SKILL.md');
    expect(r.out).toContain('scripts/run.sh');
    expect(r.out).toContain('.env');
    expect(r.asked).toEqual([S.format(S.word('publish.ask_person'), { name: 'notes-draft', version: 1 })]);
    expect(r.out).toContain(S.format(S.word('publish.published'), { name: 'notes-draft', version: 1 }));
    expect(await versionsOf(p, 'notes-draft')).toEqual([{ version: 1, publisher: 'ana' }]);
  });

  it('anything but y or yes is a no: nothing stored', async () => {
    for (const answer of ['', 'n', 'nope', 'Y es']) {
      const p = place();
      const r = await cli(p, ['publish', folder(p, 'notes-draft')], { tty: true, answers: [answer], env: AS });
      expect(r.code).toBe(0);
      expect(r.out).toContain(S.word('publish.declined_person'));
      expect(await versionsOf(p, 'notes-draft')).toEqual([]);
    }
  });

  it('a malformed skill is refused in words, with the fix, and nothing is stored (FR-01)', async () => {
    const p = place();
    const dir = join(p.dir, 'work', 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), '---\ndescription: no name here\n---\nBody.\n');
    const r = await cli(p, ['publish', dir], { tty: true, answers: ['y'], env: AS });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^invalid_manifest: /);
    expect(r.asked).toEqual([]);
  });

  it('another developer\'s skill: not_owner, nothing stored', async () => {
    const p = place();
    await cli(p, ['publish', folder(p, 'notes-draft')], { tty: true, answers: ['y'], env: AS });
    const r = await cli(p, ['publish', folder(p, 'notes-draft', 'Changed.\n')], { tty: true, answers: ['y'], env: { SKILLS_AS: 'bob' } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^not_owner: /);
    expect(await versionsOf(p, 'notes-draft')).toEqual([{ version: 1, publisher: 'ana' }]);
  });
});

describe('publish <folder> with no terminal (an assistant in a shell)', () => {
  it('previews only (nothing stored), prints the exact step-2 command, exit 3; that command publishes as printed', async () => {
    const p = place();
    const dir = folder(p, 'notes-draft');
    const r = await cli(p, ['publish', dir], { env: AS });
    expect(r.code).toBe(3);
    expect(await versionsOf(p, 'notes-draft')).toEqual([]);
    const line = r.out.split('\n').find((l) => l.includes(`${S.cli} publish `) && l.includes('--confirm'));
    expect(line, r.out).toBeDefined();
    const command = line!.slice(line!.indexOf(`${S.cli} publish `));
    // The printed command, split as a shell would split these single-quoted words.
    const words = [...command.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]!));
    expect(words.slice(0, 2)).toEqual([S.cli, 'publish']);
    const done = await cli(p, words.slice(1), { env: AS });
    expect(done.code, done.err).toBe(0);
    expect(done.out).toContain(S.format(S.word('publish.published'), { name: 'notes-draft', version: 1 }));
    expect(await versionsOf(p, 'notes-draft')).toEqual([{ version: 1, publisher: 'ana' }]);
  });

  it('a step-2 command whose folder changed since the preview: conflict, nothing stored', async () => {
    const p = place();
    const dir = folder(p, 'notes-draft');
    const r = await cli(p, ['publish', dir], { env: AS });
    const line = r.out.split('\n').find((l) => l.includes('--confirm'))!;
    const words = [...line.slice(line.indexOf(`${S.cli} publish `)).matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map((m) => (m[1] !== undefined ? m[1].replaceAll("'\\''", "'") : m[2]!));
    writeFileSync(join(dir, 'SKILL.md'), skillMd('notes-draft', 'The notes-draft skill.', 'Changed.\n'));
    const done = await cli(p, words.slice(1), { env: AS });
    expect(done.code).toBe(1);
    expect(done.err).toMatch(/^conflict: /);
    expect(await versionsOf(p, 'notes-draft')).toEqual([]);
  });

  it('--allow-suspected-secrets is the person\'s: with no terminal, nothing is done (exit 3)', async () => {
    const p = place();
    const r = await cli(p, ['publish', folder(p, 'notes-draft'), '--allow-suspected-secrets'], { env: AS });
    expect(r.code).toBe(3);
    expect(r.err).toContain(S.format(S.word('errors.person_only'), { command: `${S.cli} publish ${join(p.dir, 'work', 'notes-draft')} --allow-suspected-secrets` }).split(': ')[0]!);
    expect(await versionsOf(p, 'notes-draft')).toEqual([]);
  });

  it('no developer: the local sign-in\'s refusal, in words', async () => {
    const p = place();
    const r = await cli(p, ['publish', folder(p, 'notes-draft')]);
    expect(r.code).toBe(1);
    expect(r.err.trimEnd()).toBe(S.word('errors.unauthenticated_local'));
  });

  it('the activity log names the publish as a step of publish', async () => {
    const p = place();
    await cli(p, ['publish', folder(p, 'notes-draft')], { tty: true, answers: ['y'], env: AS });
    const line = await lastLogLine(p);
    expect(line[0]).toBe('ana');
    expect(line[1]).toBe('publish');
    expect(line[3]).toBe('notes-draft v1');
  });
});

describe('the usage list', () => {
  it('names publish', async () => {
    const p = place();
    const r = await cli(p, ['nonsense']);
    expect(r.err).toContain(`${S.cli} publish <folder>`);
  });

  it('a refusal reads as the core renders it', () => {
    expect(renderError(S, new CatalogError('not_owner', { name: 'x', owners: ['ana'] }))).toMatch(/^not_owner: /);
  });
});
