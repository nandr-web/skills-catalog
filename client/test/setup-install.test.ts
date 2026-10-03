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
import { race, runnerFolders } from './race-fs.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
afterEach(() => {
  race.stats = undefined;
});

// A test that isn't about the runner's own folders (on Linux, /tmp) sees them as root's own (race-fs.ts).
const only = (_dir: string, rewrite?: (p: string) => Record<string, unknown> | undefined) => runnerFolders(rewrite);

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
  file(join(pkg, 'package.json'), '{"name": "skills-catalog", "dependencies": {"@skills-catalog/core": "file:../core", "yaml": "2"}}');
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
  only(dir);
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

  it('the linked core, or a folder above node, another user\'s (not root\'s): writable_by_others; the walk up goes to /', () => {
    const t = installed();
    only(t.dir, (p) => (p === t.core ? { uid: me + 1 } : undefined));
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(t.core, 'writable_by_others'));
    only(t.dir, (p) => (p === dirname(t.node) ? { uid: me + 1 } : undefined));
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(dirname(t.node), 'writable_by_others'));
    // A root-owned folder doesn't end the walk: another user's folder above it is still refused.
    only(t.dir, (p) => (p === t.dir ? { uid: 0 } : p === dirname(t.dir) ? { uid: me + 1, mode: 0o40755 } : undefined));
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(dirname(t.dir), 'writable_by_others'));
  });

  it('the sticky bit makes a world-writable folder pass only above node, never above the package', () => {
    const t = installed();
    // Above node only: node's folder's parent, made apart from the package's.
    const nodeHome = dirname(dirname(t.node));
    only(t.dir, (p) => (p === dirname(t.node) ? { mode: 0o41777 } : undefined));
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(dirname(t.node), 'writable_by_others'));
    const deeper = join(nodeHome, 'node-bin', 'bin');
    file(join(deeper, 'node'));
    chmodSync(join(deeper, 'node'), 0o755);
    only(t.dir, (p) => (p === dirname(t.node) ? { mode: 0o41777 } : undefined));
    expect(refusal(() => checkInstall({ ...t.input, node: join(deeper, 'node') }))).toBeUndefined();
    // Above the package (someone could add a node_modules folder there): refused, sticky or not.
    only(t.dir, (p) => (p === t.dir ? { mode: 0o41777 } : undefined));
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(t.dir, 'writable_by_others'));
  });

  it('a group may write only as the person\'s private group, wheel or admin (named); staff or any other group is writable_by_others', () => {
    const t = installed();
    const nm = join(t.pkg, 'node_modules');
    const group = (gid: number) => only(t.dir, (p) => (p === nm ? { gid, mode: 0o40775 } : undefined));
    group(20);
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(nm, 'writable_by_others'));
    group(12345);
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(nm, 'writable_by_others'));
    group(0);
    expect(checkInstall(t.input).sharedGroup).toEqual([]);
    group(80);
    expect(checkInstall(t.input).sharedGroup).toEqual([nm]);
    if (me !== 20) {
      group(me);
      expect(checkInstall(t.input).sharedGroup).toEqual([]);
    }
  });

  it('what can\'t be looked at is refused as unreadable: a link that can\'t be followed, a folder that can\'t be listed, a dependency that isn\'t there', () => {
    const t = installed();
    symlinkSync(join(t.dir, 'nowhere'), join(t.pkg, 'dangling'));
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(join(t.pkg, 'dangling'), 'unreadable'));
    const u = installed();
    const shut = join(u.pkg, 'shut');
    mkdirSync(shut, { mode: 0o755 });
    chmodSync(shut, 0o000);
    try {
      if (me !== 0) expect(refusal(() => checkInstall(u.input))).toEqual(unsafe(shut, 'unreadable'));
    } finally {
      chmodSync(shut, 0o755);
    }
    const v = installed();
    file(join(v.pkg, 'package.json'), '{"name": "skills-catalog", "dependencies": {"left-out": "1"}}');
    expect(refusal(() => checkInstall(v.input))).toEqual(unsafe(join(v.pkg, 'node_modules', 'left-out'), 'unreadable'));
  });

  it('node in a folder that gets cleaned: temporary', () => {
    const t = installed();
    expect(refusal(() => checkInstall({ ...t.input, temporaryRoots: [dirname(t.node)] }))).toEqual(unsafe(t.node, 'temporary'));
  });

  it('a dependency found above the package, as Node finds a hoisted one, is walked too', () => {
    const t = installed();
    // yaml hoisted to a node_modules above the package: not in the package's own folder.
    const { rmSync } = race.fs;
    rmSync(join(t.pkg, 'node_modules', 'yaml'), { recursive: true });
    const hoisted = join(t.dir, 'node_modules', 'yaml');
    file(join(hoisted, 'index.js'));
    chmodSync(join(hoisted, 'index.js'), 0o666);
    expect(refusal(() => checkInstall(t.input))).toEqual(unsafe(join(hoisted, 'index.js'), 'writable_by_others'));
    chmodSync(join(hoisted, 'index.js'), 0o644);
    expect(checkInstall(t.input).node).toBe(t.node);
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
