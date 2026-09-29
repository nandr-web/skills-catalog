// The run's marker: an empty file in the run's sandbox that the run's command is given as its descriptor 3. A process
// a shell or a system program starts inherits it (a descriptor keeps its number), even in a session of its own and even
// where ps can't read its environment (a system program on macOS). So besides QA_RUN_ID in the environment, the check
// lists the processes holding the marker. It counts only a holder whose descriptor 3 is that very file (its device and
// inode, so it's found after the sandbox is gone), of this user, started at or after the run did; any other holder (an
// indexer, a backup agent, a program that opened the file itself) is named, and never counted or signalled.
//
// The limit: a process that left the run's group and holds neither the run's environment where ps can read it nor the
// marker, e.g. a system program started, in a session of its own, by a program whose spawner doesn't pass inherited
// descriptors on (node's).
import { closeSync, constants, fstatSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { pidFrom } from './pids.ts';

/** The marker's identity, and the run's start (ms) that a holder may not predate. */
export type Marker = { path: string; dev: number; ino: number; since: number };

/** Makes the marker in the run's own sandbox (never an existing file, never through a link) and opens it for the run's
 *  command's descriptor 3. The caller closes `fd` once the command has started. The file has no permissions: the open
 *  that makes it still gives this descriptor, and every later open fails, so a program of this user that opens the
 *  marker by its path (it would usually get descriptor 3) never holds it. root ignores permissions. */
export function createMarker(sandboxRoot: string, since: number): { marker: Marker; fd: number } {
  const path = join(sandboxRoot, '.run-marker');
  const fd = openSync(path, constants.O_RDONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o000);
  try {
    const st = fstatSync(fd);
    // ps gives start times to the second: a holder started in the run's first second must still count
    return { marker: { path, dev: st.dev, ino: st.ino, since: Math.floor(since / 1000) * 1000 }, fd };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** An existing file as a marker (the check's own proof that it can see holders): opened read-only, never through a link. */
export function markerOf(path: string, since: number): { marker: Marker; fd: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    return { marker: { path, dev: st.dev, ino: st.ino, since: Math.floor(since / 1000) * 1000 }, fd };
  } catch (e) {
    closeSync(fd);
    throw e;
  }
}

/** From `lsof -n -P -a -u <uid> -d 3 -F pDi`: the processes whose descriptor 3 is the marker (by device and inode). */
export function heldOnFd3(lsofOutput: string, m: Marker): number[] {
  const out: number[] = [];
  let pid: number | undefined, dev: number | undefined;
  for (const line of lsofOutput.split('\n')) {
    if (line.startsWith('p')) { pid = pidFrom(line.slice(1)); dev = undefined; }
    else if (line.startsWith('D')) dev = Number.parseInt(line.slice(1), 16);
    else if (line.startsWith('i') && pid !== undefined && dev === m.dev && Number(line.slice(1)) === m.ino && !out.includes(pid)) out.push(pid);
  }
  return out;
}

export type Holder = { pid: number; command: string };

/** From `ps -o pid=,uid=,lstart=,command= -p <pids>` (LC_ALL=C): which holders are the run's (this user's, started at or
 *  after the run did), and which aren't, with why. A pid ps no longer lists is neither. */
export function sortHolders(pids: number[], psOutput: string, m: Marker, uid: number | undefined): { ours: Holder[]; others: (Holder & { why: string })[] } {
  const ours: Holder[] = [], others: (Holder & { why: string })[] = [];
  for (const line of psOutput.split('\n')) {
    const r = /^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$/.exec(line);
    const pid = r ? pidFrom(r[1]) : undefined;
    if (!r || pid === undefined || !pids.includes(pid)) continue;
    const command = r[4]!.slice(0, 80);
    if (Number(r[2]) !== uid) others.push({ pid, command, why: "another user's" });
    else if (!(Date.parse(r[3]!) >= m.since)) others.push({ pid, command, why: 'started before the run' });
    else ours.push({ pid, command });
  }
  return { ours, others };
}
