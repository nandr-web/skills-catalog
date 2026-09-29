// Whether the installed product is safe for the session-start hook to run at every session (setup build notes §6): node
// and the script by absolute path with no character a command could read differently; not in a folder that gets
// cleaned; nothing the package loads (its own folder, each dependency's real folder) and no folder above them up to the
// first one root owns writable by others; a walk that stays within its bounds.
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, Words, renderError } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkInstall, INSTALL_UNSAFE_WHYS } from '../src/machine/setup-install.ts';
import { race } from './race-fs.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
afterEach(() => {
  race.stats = undefined;
});

const me = process.getuid!();
const file = (path: string, text = '') => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, text, { mode: 0o644 });
};

/** An installed package as npm leaves it: its folder with the bin script and a dependency, the linked core in its own
 *  folder, and a node binary, all in a sandbox (the temporary roots given apart from it). */
function installed(under = 'pkg') {
  const dir = sandbox();
  const pkg = join(dir, under);
  const core = join(dir, 'core');
  file(join(pkg, 'package.json'), '{"name": "skills-catalog"}');
  file(join(pkg, 'src', 'cli.ts'));
  file(join(pkg, 'node_modules', 'yaml', 'index.js'));
  file(join(core, 'package.json'), '{"name": "@skills-catalog/core"}');
  file(join(core, 'src', 'index.ts'));
  mkdirSync(join(pkg, 'node_modules', '@skills-catalog'));
  symlinkSync(core, join(pkg, 'node_modules', '@skills-catalog', 'core'));
  const node = join(dir, 'node-bin', 'node');
  file(node);
  chmodSync(node, 0o755);
  const temporary = join(sandbox(), 'temp');
  mkdirSync(temporary);
  return { dir, pkg, core, node, input: { node, script: join(pkg, 'src', 'cli.ts'), temporaryRoots: [temporary], uid: me } };
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
const unsafe = (path: string, why: string) => ({ code: 'install_unsafe', data: { path, why } });

describe('the install folder, for the hook that runs it at every session', () => {
  it('an ordinary install passes: node and the script by real path, the folders walked, none shared', () => {
    const { node, pkg, input } = installed();
    expect(checkInstall(input)).toEqual({ node, script: join(pkg, 'src', 'cli.ts'), sharedGroup: [] });
  });

  it('a path with a control character, $ or a backtick: path_characters', () => {
    for (const name of ['pk$g', 'pk`g', 'pk\u0007g']) {
      const { pkg, input } = installed(name);
      expect(refusal(() => checkInstall(input)), JSON.stringify(name)).toEqual(unsafe(join(pkg, 'src', 'cli.ts'), 'path_characters'));
    }
    const { dir, input } = installed();
    const node = join(dir, 'no$de');
    file(node);
    expect(refusal(() => checkInstall({ ...input, node }))).toEqual(unsafe(node, 'path_characters'));
  });

  it('a script under npx\'s cache or the temp folder: temporary', () => {
    const { pkg, input } = installed(join('_npx', 'abc', 'pkg'));
    expect(refusal(() => checkInstall(input))).toEqual(unsafe(join(pkg, 'src', 'cli.ts'), 'temporary'));
    const { dir, pkg: pkg2, input: input2 } = installed();
    expect(refusal(() => checkInstall({ ...input2, temporaryRoots: [dir] }))).toEqual(unsafe(join(pkg2, 'src', 'cli.ts'), 'temporary'));
  });

  it('anything others can write, in the package, a dependency, the linked core, node or a folder above: writable_by_others', () => {
    const cases: [string, (t: ReturnType<typeof installed>) => string][] = [
      ['a world-writable folder above the package, without the sticky bit', (t) => (chmodSync(t.dir, 0o777), t.dir)],
      ['node_modules/yaml world-writable', (t) => (chmodSync(join(t.pkg, 'node_modules', 'yaml'), 0o777), join(t.pkg, 'node_modules', 'yaml'))],
      ['a file of the package world-writable', (t) => (chmodSync(join(t.pkg, 'src', 'cli.ts'), 0o666), join(t.pkg, 'src', 'cli.ts'))],
      ['a file in the linked core world-writable', (t) => (chmodSync(join(t.core, 'src', 'index.ts'), 0o666), join(t.core, 'src', 'index.ts'))],
      ['node world-writable', (t) => (chmodSync(t.node, 0o777), t.node)],
    ];
    for (const [what, make] of cases) {
      const t = installed();
      const path = make(t);
      try {
        expect(refusal(() => checkInstall(t.input)), what).toEqual(unsafe(path, 'writable_by_others'));
      } finally {
        chmodSync(t.dir, 0o700);
      }
    }
  });

  it('the linked core, or a folder above node, another user\'s (not root\'s): writable_by_others; root\'s is where the walk up stops', () => {
    const t = installed();
    race.stats = (p) => (p === t.core ? { uid: me + 1 } : undefined);
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(t.core, 'writable_by_others'));
    race.stats = (p) => (p === dirname(t.node) ? { uid: me + 1 } : undefined);
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(dirname(t.node), 'writable_by_others'));
    // Root's folder above: the walk up stops there, so a folder above it another user owns isn't looked at.
    race.stats = (p) => (p === t.dir ? { uid: 0 } : p === dirname(t.dir) ? { uid: me + 1 } : undefined);
    expect(checkInstall(t.input).node).toBe(t.node);
  });

  it('the sticky bit makes a world-writable folder above pass; a shared group\'s folder passes and is named', () => {
    const t = installed();
    chmodSync(t.dir, 0o1777);
    try {
      expect(refusal(() => checkInstall(t.input))).toBeUndefined();
    } finally {
      chmodSync(t.dir, 0o700);
    }
    chmodSync(join(t.pkg, 'node_modules'), 0o775);
    race.stats = (p) => (p === join(t.pkg, 'node_modules') ? { gid: 20 } : undefined);
    expect(checkInstall(t.input).sharedGroup).toEqual([join(t.pkg, 'node_modules')]);
  });

  it('a walk past its bounds (entries or depth) is too_many_files; a link out is walked as its own folder, never followed', () => {
    const t = installed();
    expect(refusal(() => checkInstall({ ...t.input, limits: { entries: 5, depth: 40 } }))).toEqual(unsafe(t.pkg, 'too_many_files'));
    expect(refusal(() => checkInstall({ ...t.input, limits: { entries: 20_000, depth: 2 } }))).toEqual(unsafe(t.pkg, 'too_many_files'));
    // A link in the package to a folder that loops back is walked once.
    symlinkSync(t.pkg, join(t.core, 'loop'));
    expect(checkInstall(t.input).node).toBe(t.node);
  });

  it('every why has its own sentence, naming the path (never the data fallback)', () => {
    const s = Words.load();
    for (const why of INSTALL_UNSAFE_WHYS) {
      const text = renderError(s, new CatalogError('install_unsafe', { path: '/the/path', why }));
      expect(text, why).toMatch(/^install_unsafe: /);
      expect(text, why).toContain('/the/path');
      expect(text, why).not.toBe(renderError(s, new CatalogError('install_unsafe', { path: '/the/path', why: 'no_such_why' })));
    }
  });
});
