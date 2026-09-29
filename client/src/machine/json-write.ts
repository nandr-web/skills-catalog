// Writing a file of the person's (setup build notes §3). The new text goes to a temp file beside it (made only if absent,
// never through a link, with the old file's permission bits, or 0600 for a new file, whatever the umask), is synced, and
// right before it's placed the file is checked again: the same file, size, time, owner and mode, one link, and the same
// bytes as when it was read. Anything else is "changed": the temp file goes and the caller reads, merges and writes that
// file again. A new file is placed with link(), which fails if the path appeared meanwhile. The folder is checked after the
// place too, and a folder swapped meanwhile is target_changed, never reported as success.
//
// The limit, said plainly: Node has no compare-and-swap rename. A write by another program in the moment between the last
// check and the rename is lost; setup's backup holds what it read.

import { createHash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, renameSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { CatalogError } from '@skills-catalog/core';
import type { Snapshot } from './json-file.ts';

/** A folder's identity, taken when it's checked and compared after the place. */
export type FolderIdentity = { dev: bigint; ino: bigint };
export const folderId = (dir: string): FolderIdentity => {
  const st = lstatSync(dir, { bigint: true });
  return { dev: st.dev, ino: st.ino };
};

const lstatOr = (path: string): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
};

/** The bytes' sha256 of the file at `path`, the one `was` names, read without following a link or waiting on a fifo, or
 *  undefined when it can't be read as that file. */
function sha256Of(path: string, size: bigint, was: Snapshot): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return undefined;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== was.dev || opened.ino !== was.ino) return undefined;
    const cap = Number(size);
    const buf = Buffer.alloc(cap + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= cap; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    return n > cap ? undefined : createHash('sha256').update(buf.subarray(0, n)).digest('hex');
  } finally {
    closeSync(fd);
  }
}

/** Whether the file at `path` is still the one read: the same regular file, one link, unchanged, the same bytes. */
function unchanged(path: string, was: Snapshot): boolean {
  const st = lstatOr(path);
  if (!st || !st.isFile() || st.nlink !== 1n) return false;
  if (st.dev !== was.dev || st.ino !== was.ino || st.size !== was.size || st.mtimeNs !== was.mtimeNs || st.uid !== was.uid || st.mode !== was.mode) return false;
  return sha256Of(path, st.size, was) === was.sha256;
}

/** Writes `text` over the file at `path`, read as `was` (or found absent), in the folder `parent` was when it was
 *  checked. "changed" means someone wrote it (or made it) in between, and nothing was placed. Only the user who owns a
 *  file writes it, and a new file only in a folder that user owns, so no file ever changes owner (target_not_private). */
export function writeFileText(path: string, text: string, was: Snapshot | 'absent', parent: FolderIdentity): 'written' | 'changed' {
  const dir = dirname(path);
  const me = BigInt(process.getuid?.() ?? -1);
  if (was !== 'absent' && was.uid !== me) throw new CatalogError('target_not_private', { path, own: false });
  if (was === 'absent' && lstatOr(dir)?.uid !== me) throw new CatalogError('target_not_private', { path: dir, own: false });
  const temp = join(dir, `.${basename(path)}.skills-catalog-${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const made = fstatSync(fd, { bigint: true });
  // Removed only while it's still the temp file made here.
  const dropTemp = () => {
    const st = lstatOr(temp);
    if (st && st.dev === made.dev && st.ino === made.ino) unlinkSync(temp);
  };
  try {
    try {
      fchmodSync(fd, was === 'absent' ? 0o600 : Number(was.mode & 0o7777n));
      const bytes = Buffer.from(text, 'utf8');
      for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // The folder, looked at again before the place.
    const before = lstatOr(dir);
    if (!before?.isDirectory() || before.dev !== parent.dev || before.ino !== parent.ino) throw new CatalogError('target_changed', { path: dir });
    if (was === 'absent') {
      try {
        linkSync(temp, path);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'EEXIST') return 'changed';
        // A file system without hard links: absence checked again, then a rename.
        if (code !== 'EPERM' && code !== 'ENOTSUP') throw e;
        if (lstatOr(path)) return 'changed';
        renameSync(temp, path);
      }
    } else {
      if (!unchanged(path, was)) return 'changed';
      renameSync(temp, path);
    }
    const after = lstatOr(dir);
    if (!after?.isDirectory() || after.dev !== parent.dev || after.ino !== parent.ino) throw new CatalogError('target_changed', { path: dir });
    try {
      const d = openSync(dir, constants.O_RDONLY);
      try {
        fsyncSync(d);
      } finally {
        closeSync(d);
      }
    } catch {
      // Best effort: not every file system syncs a folder.
    }
    return 'written';
  } finally {
    dropTemp();
  }
}
