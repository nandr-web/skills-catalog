// `qa run -- <command>` (qa-plan §6): janitor, sandbox (fail-safe first), a before snapshot, the command in its own process
// group with the sandbox's settings, teardown on every ending, an after snapshot. Any difference fails the run.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, PRODUCT_DEFAULTS, snapshot, type Difference, type Watch } from './check.ts';
import { janitor, DEFAULT_TTL_MS } from './janitor.ts';
import { realRoots, type Roots } from './leftovers.ts';
import { createSandbox, realHome, sandboxBase, type Sandbox } from './sandbox.ts';
import { teardown } from './teardown.ts';

export type RunStatus = 'pass' | 'fail' | 'timeout' | 'interrupted' | 'leak';
export type RunResult = { status: RunStatus; exitCode: number | null; differences: Difference[]; sandbox: string; runId: string };

export type RunOptions = {
  command: string[];
  runId?: string;
  timeoutMs?: number;
  ttlMs?: number;
  signal?: AbortSignal;
  stdio?: 'inherit' | 'ignore';
  onStart?: (sb: Sandbox, pgid: number) => void;
  // Where the machine's places are; tests point these at a fake home. The fail-safe's home is always the real one
  // unless a test of the fail-safe itself passes `home`.
  tmp?: string; home?: string; roots?: Roots; productDefaults?: string[]; claudeJson?: string; settingsJson?: string;
  productRepo?: string | null; toolFiles?: string[];
};
/** The product repo checkout, hashed before and after every run (assistants tried to patch a crashed tool: agent-ux F12). */
export const PRODUCT_REPO = fileURLToPath(new URL('../..', import.meta.url));

export const newRunId = () => `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}-${randomBytes(3).toString('hex')}`;

export async function qaRun(o: RunOptions): Promise<RunResult> {
  const tmp = o.tmp ?? tmpdir(), roots = o.roots ?? realRoots(), home = o.home ?? realHome();
  const runId = o.runId ?? newRunId();
  janitor({ tmp, roots, ttlMs: o.ttlMs ?? DEFAULT_TTL_MS });
  const root = join(sandboxBase(tmp), runId);
  const watch = (sessions: string[], processGroups: number[]): Watch => ({
    ...roots, sandboxRoot: root, sessions, processGroups,
    claudeJson: o.claudeJson ?? join(home, '.claude.json'), settingsJson: o.settingsJson ?? join(roots.claudeDir, 'settings.json'),
    productDefaults: o.productDefaults ?? PRODUCT_DEFAULTS(home),
    productRepo: o.productRepo === null ? undefined : o.productRepo ?? PRODUCT_REPO, toolFiles: o.toolFiles,
  });
  const before = snapshot(watch([], []));
  const sb = createSandbox({ runId, tmp, home });
  const child = spawn(o.command[0], o.command.slice(1), { cwd: sb.dirs.work, env: { ...process.env, ...sb.env }, detached: true, stdio: o.stdio ?? 'ignore' });
  const pgid = child.pid!;
  o.onStart?.(sb, pgid);
  let ending: 'timeout' | 'interrupted' | undefined;
  const signalGroup = (sig: NodeJS.Signals) => { try { process.kill(-pgid, sig); } catch { /* gone */ } };
  let kill: NodeJS.Timeout | undefined;
  const stopGroup = (why: 'timeout' | 'interrupted') => {
    ending ??= why;
    signalGroup('SIGTERM');
    kill ??= setTimeout(() => signalGroup('SIGKILL'), 2000);   // a command that ignores SIGTERM still ends
  };
  const timer = o.timeoutMs ? setTimeout(() => stopGroup('timeout'), o.timeoutMs) : undefined;
  const onAbort = () => stopGroup('interrupted');
  o.signal?.addEventListener('abort', onAbort, { once: true });
  if (o.signal?.aborted) onAbort();
  let exitCode: number | null = null;
  try {
    exitCode = await new Promise<number | null>((ok) => {
      child.on('exit', (code, sig) => ok(code ?? (sig ? 128 + (({ SIGTERM: 15, SIGKILL: 9, SIGINT: 2 } as Record<string, number>)[sig] ?? 0) : null)));
      child.on('error', () => ok(127));
    });
  } finally {
    clearTimeout(timer);
    clearTimeout(kill);
    o.signal?.removeEventListener('abort', onAbort);
  }
  const sessions = await teardown(sb, { roots, processGroups: [pgid] });
  const differences = compare(before, snapshot(watch(sessions, [pgid])));
  const status: RunStatus = ending ?? (differences.length ? 'leak' : exitCode === 0 ? 'pass' : 'fail');
  return { status, exitCode, differences, sandbox: sb.root, runId };
}
