// Teardown (qa-plan §6.4): runs on every ending. Kills each process group the run started, reads the run's session ids,
// deletes the sandbox, and removes the assistant's leftovers for that sandbox and those sessions.
import { rmSync } from 'node:fs';
import { assistantLeftovers, realRoots, type Roots } from './leftovers.ts';
import { sessionsOf } from './sandbox.ts';

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

/** Returns the session ids it cleaned up after (the before/after check watches them). */
export async function teardown(sb: { root: string }, { roots = realRoots(), processGroups = [] as number[] }: { roots?: Roots; processGroups?: number[] } = {}): Promise<string[]> {
  await killGroups(processGroups);
  const sessions = sessionsOf(sb.root);
  const leftovers = assistantLeftovers(sb.root, sessions, roots);
  rmSync(sb.root, { recursive: true, force: true });
  for (const p of leftovers) rmSync(p, { recursive: true, force: true });
  return sessions;
}
