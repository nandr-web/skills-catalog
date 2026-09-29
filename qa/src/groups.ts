// One rule for every process-group signal in qa. A group's number is still the group's while the leader qa started
// hasn't been reaped (node records the exit before the number can be given out again), or, once it has, while no
// process holds that number: the system never gives out a number still in use as a group's id, so a live process with
// it means the group emptied and the number is someone else's now, maybe one of the person's own shells. (The run's id
// in the environment can't tell instead: on macOS, ps can't see a system binary's environment, so a `sleep` a run left
// behind would never be stopped.)
//
// What's left: the moment between the check and the signal; and, over the seconds a stop takes at most (SIGTERM, then
// SIGKILL), a number that emptied, went to a new process and whose new leader then exited too, leaving a new group
// with nobody holding its number. Both need the system to hand out that exact number again in that time.
//
// The second rule, the demo director's (director.ts, leftoverGroups): a group still holding one of the run's own
// processes (its QA_RUN_ID in the environment) is the run's, since a number in use by a group is never given out; so
// it's signalled without this rule. It's used where the leaders are the panes tmux started, which qa never reaped.
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
