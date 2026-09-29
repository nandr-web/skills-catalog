// The run's marker: a file in the run's sandbox that the run's command is given as its descriptor 3. A process a shell
// or a system program starts keeps it, even in a session of its own, and even where ps can't read its environment (a
// system program on macOS); so the check also lists the processes holding it. Only those holding that very file (by
// device and inode) on descriptor 3, of this user, started at or after the run did, count as the run's; any other
// holder (an indexer, a backup agent, anything opened later on another descriptor) is never listed or signalled.
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, openSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { CheckBlind, DEFAULT_TOOLS, markedProcesses } from '../src/check.ts';
import { qaRun, stopEscaped } from '../src/run.ts';
import { cleanup, machine } from './machine.ts';
import { createMarker, heldOnFd3, sortHolders, type Marker } from '../src/marker.ts';

const MARKER: Marker = { path: '/x/.run-marker', dev: 16777231, ino: 63215361, since: Date.parse('Tue Sep 29 03:31:30 2026') };

// lsof -n -P -a -u <uid> -d 3 -F pDi, as macOS prints it: a p line per process, then its descriptor's device and inode.
const LSOF = ['p100', 'f3', 'D0x100000f', 'i63215361', 'p200', 'f3', 'D0x100000f', 'i99', 'p300', 'f3', 'D0x2000001', 'i63215361', 'p400', 'f3', 'D0x100000f', 'i63215361', ''].join('\n');

describe('the processes holding the run\'s marker on descriptor 3', () => {
  it('are those whose descriptor 3 is that very file (device and inode), whatever its name now', () => {
    expect(heldOnFd3(LSOF, MARKER)).toEqual([100, 400]);   // 200: another file; 300: same inode on another device
  });

  it('nothing listed, or a garbled line: none', () => {
    expect(heldOnFd3('', MARKER)).toEqual([]);
    expect(heldOnFd3('p0\nD0x100000f\ni63215361\npx\nD0x100000f\ni63215361\n', MARKER)).toEqual([]);
  });
});

// ps -o pid=,uid=,lstart=,command= with LC_ALL=C, as macOS and Linux print it.
const PS = [
  '  100   501 Tue Sep 29 03:31:36 2026     /bin/sleep 59',
  '  400   501 Tue Sep 29 03:20:00 2026     /usr/bin/some-agent --watch',
  '  500     0 Tue Sep 29 03:31:40 2026     /usr/sbin/indexer',
  '',
].join('\n');

describe('which holders are the run\'s', () => {
  it('this user\'s, started at or after the run did; the rest are named, never the run\'s', () => {
    expect(sortHolders([100, 400, 500], PS, MARKER, 501)).toEqual({
      ours: [{ pid: 100, command: '/bin/sleep 59' }],
      others: [
        { pid: 400, command: '/usr/bin/some-agent --watch', why: 'started before the run' },
        { pid: 500, command: '/usr/sbin/indexer', why: "another user's" },
      ],
    });
  });

  it('a holder ps no longer lists (gone, or its number changed hands) is neither', () => {
    expect(sortHolders([100, 999], PS, MARKER, 501)).toEqual({ ours: [{ pid: 100, command: '/bin/sleep 59' }], others: [] });
  });
});

describe('stopping the run\'s processes', () => {
  const G = 2 ** 30;   // above any system's highest pid: were a stand-in left out, no real process could be signalled

  it('a pid listed as the run\'s but no longer the run\'s right before the signal (its number changed hands) is left alone', async () => {
    const sent: number[] = [];
    const stopped = await stopEscaped('run', DEFAULT_TOOLS, MARKER, { list: () => [{ pid: G, command: 'x' }], still: () => false, kill: (pid) => { sent.push(pid); return true; } });
    expect([stopped, sent]).toEqual([[], []]);
  });

  it('one still the run\'s is signalled', async () => {
    const sent: number[] = [];
    await stopEscaped('run', DEFAULT_TOOLS, MARKER, { list: () => [{ pid: G, command: 'x' }], still: () => true, kill: (pid) => { sent.push(pid); return true; } });
    expect(sent).toEqual([G]);
  });

  it('an lsof that fails (an exit other than 0, or 1 for none) makes the marker listing blind, never "none"', () => {
    expect(() => markedProcesses(MARKER, { ...DEFAULT_TOOLS, lsof: '/bin/sh' })).toThrow(CheckBlind);
  });
});

describe('the marker\'s number stays the run\'s until the check is done', () => {
  afterEach(cleanup);

  // Once the file is deleted and nothing holds it, its inode number is free, and a file opened later (fd 3 is often a
  // program's first) could get it: qa holds its own descriptor on the marker until the leftovers are stopped.
  it('qa still holds the marker, deleted with the sandbox, when it stops what the run left', { timeout: 60_000 }, async () => {
    const m = machine();
    let seen: { nlink: number; same: boolean } | undefined;
    await qaRun({
      machine: m, command: ['/usr/bin/true'],
      beforeStop: ({ fd, marker }) => { const st = fstatSync(fd); seen = { nlink: st.nlink, same: st.ino === marker.ino && st.dev === marker.dev }; },
    });
    expect(seen).toEqual({ nlink: 0, same: true });
  });
});

describe('a program that opens the marker by its path', () => {
  afterEach(cleanup);

  // Only the run's descriptor 3 holds the marker. A program of this user that opens the file itself (tail -f, an
  // editor, a crawler) usually gets descriptor 3 too, so were it allowed to open it, it would count as the run's and be
  // signalled. The marker has no permissions: the open that makes it still gives qa its descriptor, every later one
  // fails. (root ignores permissions, so this can't hold for a run as root.)
  it.skipIf(process.getuid?.() === 0)("can't open it, so it's never counted as the run's", { timeout: 30_000 }, async () => {
    const m = machine();
    const made = createMarker(m.dir, Date.now());
    const stranger = spawn('/bin/sh', ['-c', 'exec 3<"$1" && echo held && exec sleep 30', 'sh', made.marker.path], { stdio: ['ignore', 'pipe', 'ignore'] });
    const gone = new Promise((ok) => stranger.once('exit', ok));
    try {
      const outcome = await new Promise<'held' | 'refused'>((ok) => { stranger.stdout!.once('data', () => ok('held')); stranger.once('exit', () => ok('refused')); });
      const counted = markedProcesses(made.marker).ours.some((p) => p.pid === stranger.pid);
      let reopened: string;
      try { closeSync(openSync(made.marker.path, 'r')); reopened = 'opened'; } catch (e) { reopened = (e as NodeJS.ErrnoException).code ?? 'error'; }
      expect({ outcome, counted, reopened, mode: fstatSync(made.fd).mode & 0o777 }).toEqual({ outcome: 'refused', counted: false, reopened: 'EACCES', mode: 0 });
    } finally {
      closeSync(made.fd);
      stranger.kill('SIGKILL');
      await gone;
    }
  });
});
