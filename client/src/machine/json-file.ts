// Reading a JSON file of the person's, one way for every settings-shaped file (setup build notes §1): the permissive-mode
// check reads with it, and setup reads with it before it writes, so the same file gives the same why in both. The first
// fault wins: absent; a link; anything but a regular file; for writing, another user's file or one with more than one
// hard link; a file swapped between the look and the open (read again once); one byte over the cap; anything but strict
// UTF-8 JSON with an object at the top. Nothing is ever repaired or rewritten here.

import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';

export type FileWhy = 'unreadable' | 'too_big' | 'not_json' | 'link' | 'other_user' | 'hard_linked';
/** What a later write checks the file against: the same file, unchanged since it was read. */
export type Snapshot = { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; mode: bigint; uid: bigint; sha256: string };
export type JsonFile = { absent: true } | { why: FileWhy } | { value: Record<string, unknown>; text: string; snapshot: Snapshot };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lstatOr = (path: string): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
};

/** The JSON object in the file at `path`, read up to `cap` bytes without following a link; `forWrite` adds the checks of
 *  a file setup would write (its owner, and a single hard link). */
export function readJsonFile(path: string, cap: number, { forWrite }: { forWrite: boolean }): JsonFile {
  for (let attempt = 0; ; attempt++) {
    let st: BigIntStats | undefined;
    try {
      st = lstatOr(path);
    } catch {
      return { why: 'unreadable' };
    }
    if (!st) return { absent: true };
    if (st.isSymbolicLink()) return { why: 'link' };
    if (!st.isFile()) return { why: 'unreadable' };
    if (forWrite && st.uid !== BigInt(process.getuid?.() ?? -1)) return { why: 'other_user' };
    if (forWrite && st.nlink > 1n) return { why: 'hard_linked' };
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return { absent: true };
      return { why: code === 'ELOOP' ? 'link' : 'unreadable' };
    }
    try {
      const opened = fstatSync(fd, { bigint: true });
      // Swapped between the look and the open: looked at again once; swapped again, it can't be read as one file.
      if (opened.dev !== st.dev || opened.ino !== st.ino) {
        if (attempt === 0) continue;
        return { why: 'unreadable' };
      }
      const buf = Buffer.alloc(cap + 1);
      let n = 0;
      for (let got = 1; got > 0 && n <= cap; n += got) got = readSync(fd, buf, n, buf.length - n, null);
      if (n > cap) return { why: 'too_big' };
      const bytes = buf.subarray(0, n);
      let text: string;
      let value: unknown;
      try {
        text = utf8.decode(bytes);
        if (text.charCodeAt(0) === 0xfeff) return { why: 'not_json' };
        value = JSON.parse(text);
      } catch {
        return { why: 'not_json' };
      }
      if (typeof value !== 'object' || value === null || Array.isArray(value)) return { why: 'not_json' };
      const snapshot: Snapshot = { dev: opened.dev, ino: opened.ino, size: opened.size, mtimeNs: opened.mtimeNs, mode: opened.mode, uid: opened.uid, sha256: createHash('sha256').update(bytes).digest('hex') };
      return { value: value as Record<string, unknown>, text, snapshot };
    } catch {
      return { why: 'unreadable' };
    } finally {
      closeSync(fd);
    }
  }
}
