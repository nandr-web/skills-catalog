// Writing a file of the person's (setup build notes §3): a temp file beside it with the old file's permission bits
// (0600 for a new one), checked again right before it's placed; a file someone wrote in between, or one that appeared, is
// "changed" and left as they left it; a folder swapped after the place is target_changed, never success; no temp left.
import { join } from 'node:path';
import { CatalogError } from '@skills-catalog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readJsonFile } from '../src/machine/json-file.ts';
import { folderId, writeFileText } from '../src/machine/json-write.ts';
import { race } from './race-fs.ts';
import { clearHooks } from './race.ts';
import { place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
afterEach(clearHooks);

const folder = () => {
  const d = join(place().dir, 'a');
  race.fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
};
const temps = (d: string) => race.fs.readdirSync(d).filter((n) => n.endsWith('.tmp'));
const snapshotOf = (path: string) => {
  const r = readJsonFile(path, 1 << 20, { forWrite: true });
  if (!('snapshot' in r)) throw new Error('unusable');
  return r.snapshot;
};

describe('writing a file of the person\'s', () => {
  it('a new file: placed with mode 0600 whatever the umask, no temp left', () => {
    const d = folder();
    const path = join(d, '.claude.json');
    const umask = process.umask(0);
    try {
      expect(writeFileText(path, '{}\n', 'absent', folderId(d))).toBe('written');
    } finally {
      process.umask(umask);
    }
    expect(race.fs.readFileSync(path, 'utf8')).toBe('{}\n');
    expect(race.fs.statSync(path).mode & 0o777).toBe(0o600);
    expect(race.fs.statSync(path).nlink).toBe(1);
    expect(temps(d)).toEqual([]);
  });

  it('an existing file: replaced whole, keeping its permission bits', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    race.fs.chmodSync(path, 0o640);
    expect(writeFileText(path, '{"a": 2}', snapshotOf(path), folderId(d))).toBe('written');
    expect(race.fs.readFileSync(path, 'utf8')).toBe('{"a": 2}');
    expect(race.fs.statSync(path).mode & 0o777).toBe(0o640);
    expect(temps(d)).toEqual([]);
  });

  it('written by someone else between the read and the place: changed, left as they left it, no temp', () => {
    for (const how of ['bytes', 'same size and time']) {
      const d = folder();
      const path = join(d, 'settings.json');
      race.fs.writeFileSync(path, '{"a": 1}');
      const was = snapshotOf(path);
      // After the temp file is written, at the folder's look just before the file's own check.
      race.onLstat = (p) => {
        if (p !== d) return;
        race.onLstat = undefined;
        race.fs.writeFileSync(path, how === 'bytes' ? '{"a": 1, "b": 22}' : '{"a": 9}');
        // Same size and, as a coarse clock can show, the same modification time: only the bytes tell.
        if (how !== 'bytes') race.stats = (q) => (q === path ? { mtimeNs: was.mtimeNs } as never : undefined);
      };
      const out = writeFileText(path, '{"a": 2}', was, folderId(d));
      clearHooks();
      expect([how, out]).toEqual([how, 'changed']);
      expect(race.fs.readFileSync(path, 'utf8')).toBe(how === 'bytes' ? '{"a": 1, "b": 22}' : '{"a": 9}');
      expect(temps(d)).toEqual([]);
    }
  });

  it('a file that appeared since it was found absent: changed, never clobbered', () => {
    const d = folder();
    const path = join(d, '.claude.json');
    race.onLstat = (p) => {
      if (p !== d) return;
      race.onLstat = undefined;
      race.fs.writeFileSync(path, '{"theirs": true}');
    };
    expect(writeFileText(path, '{}\n', 'absent', folderId(d))).toBe('changed');
    expect(race.fs.readFileSync(path, 'utf8')).toBe('{"theirs": true}');
    expect(temps(d)).toEqual([]);
  });

  it('a folder swapped for a link after the place: target_changed naming it, never success', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{}');
    const moved = `${d}-moved`;
    race.afterRename = (from) => {
      if (!from.endsWith('.tmp')) return;
      race.afterRename = undefined;
      race.fs.renameSync(d, moved);
      race.fs.symlinkSync(moved, d);
    };
    let e: unknown;
    try {
      writeFileText(path, '{"a": 1}', snapshotOf(path), folderId(d));
    } catch (x) {
      e = x;
    }
    expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['target_changed', { path: d }]);
    expect(e).toBeInstanceOf(CatalogError);
  });

  it('a link or a folder where the file is: changed, the link and its target untouched', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{}');
    const was = snapshotOf(path);
    race.fs.rmSync(path);
    race.fs.writeFileSync(join(d, 'target.json'), 'mine');
    race.fs.symlinkSync(join(d, 'target.json'), path);
    expect(writeFileText(path, '{"a": 1}', was, folderId(d))).toBe('changed');
    expect(race.fs.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(race.fs.readFileSync(join(d, 'target.json'), 'utf8')).toBe('mine');
    expect(temps(d)).toEqual([]);
  });
});
