// The activity log, for the demo's bottom pane: one plain line per tool call, `HH:MM:SS  who  tool  result  target`
// (UTC, spaces only). The result is one of the surface's log words (its top-level `log` section), padded to the longest
// of them, so the target, which can be long (skill names run to 64 characters), comes last and never shifts a column.
// The caller builds the target from the result (skill names and versions, a match count), so nothing an assistant
// typed, and no skill text, ever reaches it. Writing it never fails or stalls a tool call: the log is for watching.
import { closeSync, constants, fchmodSync, fstatSync, mkdirSync, openSync, writeSync, type Stats } from 'node:fs';
import { dirname } from 'node:path';
import type { Surface } from '@skills-catalog/core';

export type Activity = { at: Date; who?: string | undefined; tool: string; target: string; result: string };

/** The log's words from the surface: a search's target, a result by operation (and outcome), an error by code, and the
 *  result column's width (the longest word). */
export type LogWords = { width: number; searchTarget: (count: number, total: number) => string; result: (op: string, outcome?: string) => string; error: (code: string) => string };

const cache = new WeakMap<Surface, LogWords>();

export function logWords(s: Surface): LogWords {
  const known = cache.get(s);
  if (known) return known;
  const log = s.fill(s.doc.log) as { search_target: string; result: Record<string, string | Record<string, string>>; error: Record<string, string> };
  const all = [...Object.values(log.result).flatMap((w) => (typeof w === 'string' ? [w] : Object.values(w))), ...Object.values(log.error)];
  const words: LogWords = {
    width: Math.max(...all.map((w) => w.length)),
    searchTarget: (count, total) => s.format(log.search_target, { count, total }),
    result: (op, outcome) => {
      const w = log.result[op];
      const word = typeof w === 'string' ? w : outcome === undefined ? undefined : w?.[outcome];
      if (word === undefined) throw new Error(`the surface's log has no result for ${op}${outcome ? ` (${outcome})` : ''}`);
      return word;
    },
    // A code the log has no word for is shown as refused, with its code (the surface's rule).
    error: (code) => log.error[code] ?? `refused: ${code}`,
  };
  cache.set(s, words);
  return words;
}

export function activityLine(a: Activity, resultWidth: number): string {
  return `${a.at.toISOString().slice(11, 19)}  ${(a.who ?? '-').padEnd(4)}  ${a.tool.padEnd(27)}  ${a.result.padEnd(resultWidth)}  ${a.target}\n`;
}

// The client's own folder tightened to 0700 when looser: checked and changed through a handle opened without following
// a link (a link in its place is left alone, and so is its target), and only when this user owns it. Never by path, so
// nothing swapped in between a check and the change is ever changed.
function tightenOwnFolder(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (st.isDirectory() && st.uid === process.getuid?.() && (st.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
  } catch {
    // a link or something else in its place: left as it is
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// A log file this user owns, with no other name (a hard link would put the line, and the mode change, somewhere else).
const ours = (st: Stats) => st.isFile() && st.nlink === 1 && st.uid === process.getuid?.();

/** Appends one line. The folder is made 0700 if it's missing, and tightened to 0700 when it's the client's own
 *  (`ownFolder`, SKILLS_HOME: a folder the person named with SKILLS_ACTIVITY_LOG is theirs, e.g. /tmp, and left alone);
 *  the file is 0600, tightened if it was looser. Only a regular file of this user's with no other name is written: a
 *  link in the log's place is never followed (O_NOFOLLOW), and a FIFO or other special file never blocks the server
 *  (O_NONBLOCK, then fstat); the line is dropped instead. One write per line, with O_APPEND, so two servers appending
 *  at once never tear a line. */
export function appendActivity(path: string, a: Activity, o: { ownFolder?: boolean; resultWidth: number }): void {
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (o.ownFolder) tightenOwnFolder(dir);
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const st = fstatSync(fd);
      if (!ours(st)) return;
      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      writeSync(fd, Buffer.from(activityLine(a, o.resultWidth)));
    } finally {
      closeSync(fd);
    }
  } catch {
    // dropped: the tool call's answer matters, its log line doesn't
  }
}
