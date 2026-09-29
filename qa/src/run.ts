// `qa run -- <command>` (the QA plan §6): fail-safe, janitor, a before snapshot, the sandbox, the command in its own
// process group with the sandbox's settings, teardown on every ending, an after snapshot. Any difference fails the run;
// a process of the run still alive after teardown is reported, then stopped.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compare, runProcesses, snapshot, watchOn, type Difference } from './check.ts';
import { janitor, DEFAULT_TTL_MS } from './janitor.ts';
import type { Cleanup } from './leftovers.ts';
import type { Machine } from './machine.ts';
import { childEnv, createSandbox, failSafe, newRunId, recordProcessGroup, sandboxBase, type Sandbox } from './sandbox.ts';
import { teardown } from './teardown.ts';

export { newRunId };
export type RunStatus = 'pass' | 'fail' | 'timeout' | 'interrupted' | 'leak';
export type RunResult = { status: RunStatus; exitCode: number | null; differences: Difference[]; sandbox: string; runId: string; stopped: number[]; janitor: Cleanup; teardown: Cleanup };

/** Shorter than the janitor's TTL, so a stuck run ends before it could look stale. */
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;

export type RunOptions = {
  command: string[];
  machine: Machine;
  runId?: string;
  timeoutMs?: number;
  ttlMs?: number;
  signal?: AbortSignal;
  stdio?: 'inherit' | 'ignore';
  onStart?: (sb: Sandbox, pgid: number) => void;
  productRepo?: string | null; toolFiles?: string[];
};
/** The product repo checkout, hashed before and after every run (assistants tried to patch a crashed tool). */
export const PRODUCT_REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Stop processes that carry the run's id after teardown (they left its process groups); returns their pids once they're gone. */
export async function stopEscaped(runId: string): Promise<number[]> {
  const pids = runProcesses(runId).map((p) => p.pid);
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  for (let waited = 0; waited < 2000 && pids.some(alive); waited += 20) await new Promise((r) => setTimeout(r, 20));
  return pids;
}

export async function qaRun(o: RunOptions): Promise<RunResult> {
  const m = o.machine;
  const runId = o.runId ?? newRunId();
  failSafe([sandboxBase(m.tmp)], m.home);
  const swept = janitor({ machine: m, ttlMs: o.ttlMs ?? DEFAULT_TTL_MS });
  const root = `${sandboxBase(m.tmp)}/${runId}`;
  const watch = (processGroups: number[]) => watchOn(m, {
    sandboxRoot: root, runId, processGroups,
    productRepo: o.productRepo === null ? undefined : o.productRepo ?? PRODUCT_REPO, toolFiles: o.toolFiles,
  });
  const before = snapshot(watch([]));
  const sb = createSandbox({ runId, machine: m });
  let pgid = 0;
  let ending: 'timeout' | 'interrupted' | undefined;
  let exitCode: number | null = null;
  let timer: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const signalGroup = (sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* gone */ } };
  const stopGroup = (why: 'timeout' | 'interrupted') => {
    ending ??= why;
    signalGroup('SIGTERM');
    kill ??= setTimeout(() => signalGroup('SIGKILL'), 2000);   // a command that ignores SIGTERM still ends
  };
  const onAbort = () => stopGroup('interrupted');
  let cleanup: Cleanup | undefined;
  try {
    const child = spawn(o.command[0], o.command.slice(1), { cwd: sb.dirs.work, env: childEnv(sb), detached: true, stdio: o.stdio ?? 'ignore' });
    pgid = child.pid!;
    recordProcessGroup(sb, pgid);
    o.onStart?.(sb, pgid);
    timer = setTimeout(() => stopGroup('timeout'), o.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    exitCode = await new Promise<number | null>((ok) => {
      child.on('exit', (code, sig) => ok(code ?? (sig ? 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 } as Record<string, number>)[sig] ?? 0) : null)));
      child.on('error', () => ok(127));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(kill);
    o.signal?.removeEventListener('abort', onAbort);
    // A command's session ids aren't trusted (it can write anything into its sandbox): qa run deletes no session folder.
    cleanup = await teardown(sb, { machine: m, processGroups: pgid ? [pgid] : [] });
  }
  const differences = compare(before, snapshot(watch(pgid ? [pgid] : [])));
  const stopped = await stopEscaped(runId);
  const status: RunStatus = ending ?? (differences.length ? 'leak' : exitCode === 0 ? 'pass' : 'fail');
  return { status, exitCode, differences, sandbox: sb.root, runId, stopped, janitor: swept, teardown: cleanup };
}
