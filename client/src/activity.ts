// The activity log, for the demo's bottom pane: one plain line per tool call, `HH:MM:SS  who  tool  target  result`
// (UTC, spaces only). The caller builds the target from the result (skill names and versions, a match count) and
// the result from fixed words, so nothing an assistant typed, and no skill text, ever reaches it. Writing it never
// fails a tool call: the log is for watching.
import { closeSync, constants, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export type Activity = { at: Date; who?: string | undefined; tool: string; target: string; result: string };

export function activityLine(a: Activity): string {
  return `${a.at.toISOString().slice(11, 19)}  ${(a.who ?? '-').padEnd(4)}  ${a.tool.padEnd(27)}  ${a.target.padEnd(26)}  ${a.result}\n`;
}

/** Appends one line: the folder is made 0700 if it's missing, the file 0600; a link in the log's place is never
 *  followed (O_NOFOLLOW), so the line is dropped instead. One write per line, with O_APPEND, so two servers
 *  appending at once never tear a line. */
export function appendActivity(path: string, a: Activity): void {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, Buffer.from(activityLine(a)));
    } finally {
      closeSync(fd);
    }
  } catch {
    // dropped: the tool call's answer matters, its log line doesn't
  }
}
