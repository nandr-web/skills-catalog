// Teardown (the QA plan §6.4): runs on every ending. Kills each process group the run started, removes the run's own
// leftovers (exact names, session ids from the run's own stream, never a folder that existed before the run), then the
// sandbox itself, last, so an interrupted teardown leaves the run folder for the janitor (§6.5a).
import { dirname } from 'node:path';
import { removeRunLeftovers, type Cleanup } from './leftovers.ts';
import type { Machine } from './machine.ts';
import { removeRun, verifyBase } from './safe-delete.ts';
import type { Sandbox } from './sandbox.ts';

const alive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function killGroups(pgids: number[], graceMs = 2000): Promise<void> {
  const signal = (pgid: number, sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* already gone */ } };
  const live = pgids.filter(alive);
  for (const g of live) signal(g, 'SIGTERM');
  for (let waited = 0; waited < graceMs && live.some(alive); waited += 50) await sleep(50);
  for (const g of live.filter(alive)) signal(g, 'SIGKILL');
  for (let waited = 0; waited < 1000 && live.some(alive); waited += 20) await sleep(20);
}

/** `sessions`: ids from the run's own stream, kept in memory by the runner (never read back from the sandbox);
 *  `sessionEnvsBefore`: the session-env folder's names before the assistant started. */
export async function teardown(sb: Pick<Sandbox, 'root' | 'runId' | 'preexisting'>, o: { machine: Machine; sessions?: string[]; sessionEnvsBefore?: ReadonlySet<string>; processGroups?: number[] }): Promise<Cleanup> {
  await killGroups(o.processGroups ?? []);
  const base = dirname(sb.root);
  verifyBase(base);
  const out = removeRunLeftovers(sb.root, o.machine, { preexisting: sb.preexisting, sessions: o.sessions, sessionEnvsBefore: o.sessionEnvsBefore });
  out.removed.push(removeRun(base, sb.runId));
  return out;
}
