// `qa run -- <command>` (the QA plan §6): fail-safe, janitor, a before snapshot, the sandbox, the command in its own
// process group with the sandbox's settings, teardown on every ending, an after snapshot. Any difference fails the run;
// a process of the run still alive after teardown is reported, then stopped.
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync } from 'node:fs';
import { signalGroup } from './groups.ts';
import { fileURLToPath } from 'node:url';
import { allRunProcesses, checkSees, compare, markedProcesses, runProcesses, snapshot, watchOn, type Difference, type Tools } from './check.ts';
import { createMarker, type Holder, type Marker } from './marker.ts';
import { janitor, DEFAULT_TTL_MS } from './janitor.ts';
import type { Cleanup } from './leftovers.ts';
import type { Machine } from './machine.ts';
import { childEnv, createSandbox, failSafe, newRunId, recordProcessGroup, sandboxBase, type Sandbox } from './sandbox.ts';
import { teardown } from './teardown.ts';

export { newRunId };
export type RunStatus = 'pass' | 'fail' | 'timeout' | 'interrupted' | 'leak';
export type RunResult = { status: RunStatus; exitCode: number | null; differences: Difference[]; sandbox: string; runId: string; stopped: number[]; janitor: Cleanup; teardown: Cleanup; notTheRuns?: (Holder & { why: string })[] };

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
  tools?: Tools;
};
/** The product repo checkout, hashed before and after every run (assistants tried to patch a crashed tool). */
export const PRODUCT_REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Whether `pid` is still one of the run's: carrying its id, or holding its marker as the run's (marker.ts). Can't
 *  look: no. */
function stillTheRuns(pid: number, runId: string, marker: Marker | undefined, tools?: Tools): boolean {
  try {
    return runProcesses(runId, tools).some((p) => p.pid === pid) || (!!marker && markedProcesses(marker, tools, [pid]).ours.some((p) => p.pid === pid));
  } catch {
    return false;
  }
}

/** Stop the run's processes still running after teardown (they left its process groups): those carrying its id and
 *  those holding its marker, each looked at again right before the signal, so a number that changed hands since it was
 *  listed is left alone. Returns the pids signalled, once they're gone. */
export async function stopEscaped(runId: string, tools?: Tools, marker?: Marker, sys = { list: allRunProcesses, still: stillTheRuns, kill: (pid: number) => process.kill(pid, 'SIGKILL') }): Promise<number[]> {
  const stopped: number[] = [];
  for (const { pid } of sys.list(runId, marker, tools)) {
    if (!sys.still(pid, runId, marker, tools)) continue;
    try { sys.kill(pid); stopped.push(pid); } catch { /* gone */ }
  }
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let waited = 0; waited < 2000 && stopped.some(alive); waited += 20) await new Promise((r) => setTimeout(r, 20));
  return stopped;
}

export async function qaRun(o: RunOptions): Promise<RunResult> {
  const m = o.machine;
  const runId = o.runId ?? newRunId();
  failSafe([sandboxBase(m.tmp)], m.home);
  await checkSees(runId, o.tools);   // a check that can't see refuses the run before anything starts
  const swept = janitor({ machine: m, ttlMs: o.ttlMs ?? DEFAULT_TTL_MS });
  const root = `${sandboxBase(m.tmp)}/${runId}`;
  const watch = (processGroups: number[]) => watchOn(m, {
    sandboxRoot: root, runId, processGroups, tools: o.tools, marker,
    productRepo: o.productRepo === null ? undefined : o.productRepo ?? PRODUCT_REPO, toolFiles: o.toolFiles,
  });
  let marker: Marker | undefined;
  const before = snapshot(watch([]));
  const sb = createSandbox({ runId, machine: m });
  let pgid = 0;
  let child: ChildProcess | undefined;
  let ending: 'timeout' | 'interrupted' | undefined;
  let exitCode: number | null = null;
  let timer: NodeJS.Timeout | undefined, kill: NodeJS.Timeout | undefined;
  const signal = (sig: NodeJS.Signals) => { signalGroup(pgid, sig, child); };
  const stopGroup = (why: 'timeout' | 'interrupted') => {
    ending ??= why;
    signal('SIGTERM');
    kill ??= setTimeout(() => signal('SIGKILL'), 2000);   // a command that ignores SIGTERM still ends
  };
  const onAbort = () => stopGroup('interrupted');
  let cleanup: Cleanup | undefined;
  try {
    // The run's marker as the command's descriptor 3: what it starts keeps it (marker.ts). qa's own copy closes at once.
    const made = createMarker(sb.root, Date.now());
    marker = made.marker;
    const io = o.stdio ?? 'ignore';
    let started: ChildProcess;
    try {
      started = spawn(o.command[0], o.command.slice(1), { cwd: sb.dirs.work, env: childEnv(sb), detached: true, stdio: [io, io, io, made.fd] });
    } finally {
      closeSync(made.fd);
    }
    child = started;
    pgid = started.pid!;
    recordProcessGroup(sb, pgid);
    o.onStart?.(sb, pgid);
    // Infinity: no time limit (an attached demo, which the person stops); setTimeout would read it as 1 ms
    const limit = o.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (limit !== Infinity) timer = setTimeout(() => stopGroup('timeout'), limit);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    if (o.signal?.aborted) onAbort();
    exitCode = await new Promise<number | null>((ok) => {
      started.on('exit', (code, sig) => ok(code ?? (sig ? 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 } as Record<string, number>)[sig] ?? 0) : null)));
      started.on('error', () => ok(127));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(kill);
    o.signal?.removeEventListener('abort', onAbort);
    // A command's session ids aren't trusted (it can write anything into its sandbox): qa run deletes no session folder.
    cleanup = await teardown(sb, { machine: m, processGroups: pgid ? [pgid] : [], leaders: child ? [child] : [] });
  }
  const differences = compare(before, snapshot(watch(pgid ? [pgid] : [])));
  // Holders of the marker that aren't the run's (another user's, or started before the run): named, never signalled.
  let notTheRuns: (Holder & { why: string })[] = [];
  try { notTheRuns = marker ? markedProcesses(marker, o.tools).others : []; } catch { /* the check above already refused a blind lsof */ }
  const stopped = await stopEscaped(runId, o.tools, marker);
  const status: RunStatus = ending ?? (differences.length ? 'leak' : exitCode === 0 ? 'pass' : 'fail');
  return { status, exitCode, differences, sandbox: sb.root, runId, stopped, janitor: swept, teardown: cleanup, notTheRuns };
}
