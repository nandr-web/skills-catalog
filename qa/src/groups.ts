// One rule for every process-group signal in qa. A group's number is still the group's while the leader qa started
// hasn't been reaped (node records the exit before the number can be given out again), or, once it has, while no
// process holds that number: the system never gives out a number still in use as a group's id, so a live process with
// it means the group emptied and the number is someone else's now, maybe one of the person's own shells. What's left is
// the race between that check and the signal. (The run's id in the environment can't tell instead: on macOS, ps can't
// see a system binary's environment, so a `sleep` a run left behind would never be stopped.)
import type { ChildProcess } from 'node:child_process';

/** Whether a process with this number exists (someone else's counts: it's there). */
export function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A leader qa started is running until node has seen it exit. */
export const running = (c: Pick<ChildProcess, 'exitCode' | 'signalCode'> | undefined): boolean => !!c && c.exitCode === null && c.signalCode === null;

/** Whether the group numbered `pgid` is still the one qa started. */
export const groupIsOurs = (pgid: number, leaderRunning: boolean, pidAlive: (pid: number) => boolean = exists): boolean => leaderRunning || !pidAlive(pgid);

/** Signals the group qa started with `leader` (or whose leader it knows only by number) when it's still that group.
 *  Returns whether a signal was sent. */
export function signalGroup(pgid: number, sig: NodeJS.Signals, leader?: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  if (!(pgid > 0) || !groupIsOurs(pgid, running(leader))) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;   // already gone
  }
}
