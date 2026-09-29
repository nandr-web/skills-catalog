// Teardown (the QA plan §6.4): runs on every ending. Kills each process group the run started, removes the run's own
// leftovers (exact names, session ids from the run's own stream, never a folder that existed before the run), then the
// sandbox itself, last, so an interrupted teardown leaves the run folder for the janitor (§6.5a).
import type { ChildProcess } from 'node:child_process';
import { dirname } from 'node:path';
import { exists, groupIsOurs } from './groups.ts';
import { removeRunLeftovers, type Cleanup } from './leftovers.ts';
import type { Machine } from './machine.ts';
import { removeRun, verifyBase } from './safe-delete.ts';
import type { Sandbox } from './sandbox.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SYS = {
  pidAlive: (pid: number) => exists(pid),
  groupAlive: (pgid: number) => exists(-pgid),
  signal: (pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* already gone */ } },
  sleep,
};

/** Stops the run's process groups: SIGTERM, then SIGKILL after `graceMs`, each group only while it's still the run's
 *  (groups.ts, the one rule), checked again right before each signal. `leaderAlive`: a leader the caller started and
 *  knows is still running. */
export async function killGroups(pgids: number[], graceMs = 2000, o: { leaderAlive?: (pgid: number) => boolean; sys?: Partial<typeof SYS> } = {}): Promise<void> {
  const sys = { ...SYS, ...o.sys };
  const ours = (g: number) => sys.groupAlive(g) && groupIsOurs(g, o.leaderAlive?.(g) ?? false, sys.pidAlive);
  const live = pgids.filter((g) => g > 0 && ours(g));   // 0 is qa's own group, -1 every process
  for (const g of live) if (ours(g)) sys.signal(g, 'SIGTERM');
  for (let waited = 0; waited < graceMs && live.some(ours); waited += 50) await sys.sleep(50);
  for (const g of live) if (ours(g)) sys.signal(g, 'SIGKILL');
  for (let waited = 0; waited < 1000 && live.some(ours); waited += 20) await sys.sleep(20);
}

/** `sessions`: ids from the run's own stream, kept in memory by the runner (never read back from the sandbox);
 *  `sessionEnvsBefore`: the session-env folder's names before the assistant started; `processGroups`: the groups the
 *  run's programs lead; `leaders`: those programs, when the caller still has them (a leader still running holds its
 *  group's number). */
export async function teardown(sb: Pick<Sandbox, 'root' | 'runId' | 'preexisting'>, o: { machine: Machine; sessions?: string[]; sessionEnvsBefore?: ReadonlySet<string>; processGroups?: number[]; leaders?: ChildProcess[] }): Promise<Cleanup> {
  const leaderAlive = (g: number) => (o.leaders ?? []).some((c) => c.pid === g && c.exitCode === null && c.signalCode === null);
  await killGroups(o.processGroups ?? [], 2000, { leaderAlive });
  const base = dirname(sb.root);
  verifyBase(base);
  const out = removeRunLeftovers(sb.root, o.machine, { preexisting: sb.preexisting, sessions: o.sessions, sessionEnvsBefore: o.sessionEnvsBefore });
  out.removed.push(removeRun(base, sb.runId));
  return out;
}
