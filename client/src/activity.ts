// The activity log, for the demo's bottom pane: one plain line per tool call, `HH:MM:SS  who  tool  result  target`
// (UTC, spaces only). The result is padded to the longest one, so the target, which can be long (skill names run to 64
// characters), comes last and never shifts a column. The caller builds the target from the result (skill names and
// versions, a match count) and the result from fixed words, so nothing an assistant typed, and no skill text, ever
// reaches it. Writing it never fails or stalls a tool call: the log is for watching.
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, chmodSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type Activity = { at: Date; who?: string | undefined; tool: string; target: string; result: string };

/** The widest result: a result code (the longest, invalid_developer_setting), until the surface's log words land. */
export const RESULT_WIDTH = 25;

export function activityLine(a: Activity): string {
  return `${a.at.toISOString().slice(11, 19)}  ${(a.who ?? '-').padEnd(4)}  ${a.tool.padEnd(27)}  ${a.result.padEnd(RESULT_WIDTH)}  ${a.target}\n`;
}

/** Appends one line. The folder is made 0700 if it's missing, and tightened to 0700 when it's the client's own
 *  (`ownFolder`, SKILLS_HOME: a folder the person named with SKILLS_ACTIVITY_LOG is theirs, e.g. /tmp, and left alone);
 *  the file is 0600, tightened if it was looser. Only a regular file is written: a link in the log's place is never
 *  followed (O_NOFOLLOW), and a FIFO or other special file never blocks the server (O_NONBLOCK, then fstat); the line
 *  is dropped instead. One write per line, with O_APPEND, so two servers appending at once never tear a line. */
export function appendActivity(path: string, a: Activity, o: { ownFolder?: boolean } = {}): void {
  try {
    const dir = dirname(path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (o.ownFolder) {
      const st = lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink() && (st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return;
      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      writeSync(fd, Buffer.from(activityLine(a)));
    } finally {
      closeSync(fd);
    }
  } catch {
    // dropped: the tool call's answer matters, its log line doesn't
  }
}
