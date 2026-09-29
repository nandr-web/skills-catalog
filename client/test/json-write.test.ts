// Writing a file of the person's (setup build notes §3): a temp file beside it with the old file's permission bits
// (0600 for a new one), checked again right before it's placed; a file someone wrote in between, or one that appeared, is
// "changed" and left as they left it; a folder swapped after the place is target_changed, never success; no temp left.
import { constants } from 'node:fs';
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

  it('the temp file is made new and never through a link; the file read again before the place is no-follow and non-blocking', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{}');
    const opens: [string, number][] = [];
    race.onOpen = (p, f) => void (p.startsWith(d) && opens.push([p, Number(f)]));
    expect(writeFileText(path, '{"a": 1}', snapshotOf(path), folderId(d))).toBe('written');
    const has = (f: number, bits: number) => (f & bits) === bits;
    const temp = opens.filter(([p]) => p.endsWith('.tmp'));
    const again = opens.filter(([p]) => p === path);
    expect(temp.length).toBe(1);
    expect(has(temp[0]![1], constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW)).toBe(true);
    // The snapshot's own read, then the check right before the place: each one no-follow and non-blocking.
    expect(again.length).toBeGreaterThanOrEqual(2);
    for (const [, f] of again) expect(has(f, constants.O_NOFOLLOW | constants.O_NONBLOCK)).toBe(true);
  });

  it('the bytes read again right before the place must be the same file\'s: another file with the same bytes is changed', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    const was = snapshotOf(path);
    // After the last look and before the read: a new file (a new inode) with the very same bytes takes its place.
    race.onOpen = (p) => {
      if (p !== path) return;
      race.onOpen = undefined;
      race.fs.writeFileSync(`${path}.new`, '{"a": 1}');
      race.fs.renameSync(`${path}.new`, path);
    };
    expect(writeFileText(path, '{"a": 2}', was, folderId(d))).toBe('changed');
    expect(race.fs.readFileSync(path, 'utf8')).toBe('{"a": 1}');
    expect(temps(d)).toEqual([]);
  });

  it('keeps the file\'s permission bits and its group, never a setuid, setgid or sticky bit', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    race.fs.chmodSync(path, 0o2640);
    // Another group of this user's, where there is one, to show the group is kept rather than taken from the folder.
    const mine = (process.getgroups?.() ?? []).map(Number);
    const other = mine.find((g) => g !== race.fs.statSync(path).gid);
    if (other !== undefined) race.fs.chownSync(path, process.getuid?.() ?? 0, other);
    const was = snapshotOf(path);
    expect(writeFileText(path, '{"a": 2}', was, folderId(d))).toBe('written');
    const st = race.fs.statSync(path);
    expect([st.mode & 0o7777, st.gid]).toEqual([0o640, Number(was.gid)]);
  });

  it('where the group can\'t be kept, the group loses its access: another group never gains it', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    race.fs.chmodSync(path, 0o664);
    race.onFchown = () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    };
    expect(writeFileText(path, '{"a": 2}', snapshotOf(path), folderId(d))).toBe('written');
    clearHooks();
    expect(race.fs.statSync(path).mode & 0o777).toBe(0o604);
  });

  it('the folder is looked at before anything is made in it: a folder swapped since its check gets no temp copy', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    const was = snapshotOf(path);
    const checked = folderId(d);
    const moved = `${d}-moved`;
    race.fs.renameSync(d, moved);
    race.fs.mkdirSync(d, { mode: 0o700 });
    race.fs.writeFileSync(path, '{"a": 1}');
    const temps: string[] = [];
    race.onOpen = (p) => void (p.endsWith('.tmp') && temps.push(p));
    let e: unknown;
    try {
      writeFileText(path, '{"a": 2}', was, checked);
    } catch (x) {
      e = x;
    }
    expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['target_changed', { path: d }]);
    // Not made and removed: never made, so a crash can't leave a copy of the file anywhere.
    expect(temps).toEqual([]);
    expect([race.fs.readdirSync(d), race.fs.readdirSync(moved)]).toEqual([['settings.json'], ['settings.json']]);
  });

  it('a disk that fills mid-write: the error is thrown, the file is as it was, no temp left', () => {
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    const was = snapshotOf(path);
    race.onWrite = () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
    let e: unknown;
    try {
      writeFileText(path, '{"a": 2}', was, folderId(d));
    } catch (x) {
      e = x;
    }
    clearHooks();
    expect((e as NodeJS.ErrnoException).code).toBe('ENOSPC');
    expect(race.fs.readFileSync(path, 'utf8')).toBe('{"a": 1}');
    expect(temps(d)).toEqual([]);
  });

  it('never writes a file another user owns, or a new file in a folder another user owns: target_not_private, nothing made', () => {
    const me = process.getuid?.() ?? 0;
    const d = folder();
    const path = join(d, 'settings.json');
    race.fs.writeFileSync(path, '{"a": 1}');
    const was = { ...snapshotOf(path), uid: BigInt(me + 1) };
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (x) {
        return x as CatalogError;
      }
      return undefined;
    };
    const theirs = refusal(() => writeFileText(path, '{"a": 2}', was, folderId(d)));
    expect([theirs?.code, theirs?.data]).toEqual(['target_not_private', { path, own: false }]);
    expect(race.fs.readFileSync(path, 'utf8')).toBe('{"a": 1}');
    race.stats = (p) => (p === d ? { uid: me + 1 } : undefined);
    const fresh = join(d, '.claude.json');
    const folderTheirs = refusal(() => writeFileText(fresh, '{}\n', 'absent', folderId(d)));
    clearHooks();
    expect([folderTheirs?.code, folderTheirs?.data]).toEqual(['target_not_private', { path: d, own: false }]);
    expect(race.fs.existsSync(fresh)).toBe(false);
    expect(temps(d)).toEqual([]);
  });
});
