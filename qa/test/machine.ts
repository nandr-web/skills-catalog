// A fake machine per test (qa-plan §6.5a, "Tests never reach real roots"): its own tmp (where sandboxes go), a home with
// ~/.claude, and Claude Code's tmp and cache folders, all inside a temporary folder of the test's own. Every test of the clean-run
// machinery passes one explicitly, and the qa command line runs here only with `--fake-machine <dir>`.
// This file is the only test code that starts the qa command line (test/meta.test.ts checks that).
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { DEFAULT_TOOLS, PS, runProcesses } from '../src/check.ts';
import { exists, groupIsOurs, signalGroup } from '../src/groups.ts';
import { fakeMachine, type Machine } from '../src/machine.ts';
import { RUN_ID } from '../src/safe-delete.ts';
import { sandboxBase } from '../src/sandbox.ts';

/** The budget for a test that starts processes and runs the before/after check (`ps` over every process, `lsof`): a few
 *  seconds each on a busy machine, near vitest's default 5 s. Set per file (vi.setConfig) in the files whose tests do
 *  that, so a plain unit test keeps the default and still fails fast if it hangs. */
export const PROCESS_TEST_MS = 30_000;

/** A child in a process group of its own, for tests of the process checks. Its whole group is killed when the test
 *  ends, however it ends: onTestFinished runs after a failure or a timeout too, where a `finally` in the test doesn't. */
export function spawnDetached(command: string, args: string[], o: SpawnOptions = {}): ChildProcess {
  const child = spawn(command, args, { stdio: 'ignore', ...o, detached: true });
  onTestFinished(() => stopGroup(child));
  return child;
}

/** Kill a detached child's whole group while it's still that group (src/groups.ts, the one rule): its leader not yet
 *  reaped, or no process holding its number; members that outlived their leader go too. */
export function stopGroup(child: ChildProcess): void {
  if (child.pid) signalGroup(child.pid, 'SIGKILL', child);
}

const kill = (pid: number) => {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // already gone
  }
};

/** The runs whose sandboxes are in a test's folder (a fake machine's tmp/skills-catalog-qa/<run-id>). */
const runsIn = (d: string) => {
  const base = sandboxBase(join(d, 'tmp'));
  return existsSync(base) ? readdirSync(base).filter((n) => RUN_ID.test(n)) : [];
};

const made: string[] = [];
/** Call from afterEach, which runs after a timeout too. First every process still carrying the exact id of a run whose
 *  sandbox is in the test's own folders (a test that timed out never reached its run's teardown), each one looked at
 *  again right before the signal; never by name or port. Then the folders. */
export const cleanup = () => {
  try {
    for (const d of made) for (const id of runsIn(d)) for (const p of runProcesses(id)) if (runProcesses(id).some((q) => q.pid === p.pid)) kill(p.pid);
  } finally {
    for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });   // even when the sweep can't look
  }
};

/** A temporary folder of the test's own, by its real path. */
export function scratch(prefix = 'qa-test-'): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

/** The real ps, every start time it prints 90 s early (fixtures/skewed-ps.cjs), by its full path in the test's own folder. */
export function skewedPs(): string {
  const p = join(scratch(), 'ps');
  writeFileSync(p, `#!/bin/sh\nexec '${process.execPath}' '${fileURLToPath(new URL('./fixtures/skewed-ps.cjs', import.meta.url))}' '${DEFAULT_TOOLS.ps}' "$@"\n`);
  chmodSync(p, 0o700);
  return p;
}

export type TestMachine = Machine & { dir: string };
export const machine = (): TestMachine => { const dir = scratch(); return { dir, ...fakeMachine(dir) }; };

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const MACHINE_COMMANDS = new Set(['run', 'janitor', 'agent', 'demo']);
/** qa's own flags go before `--`; --fake-machine goes right after the command's name. */
const args = (m: TestMachine | null, a: string[]) => (m && MACHINE_COMMANDS.has(a[0]) ? [a[0], '--fake-machine', m.dir, ...a.slice(1)] : a);

/** Which process started a qa command: it watches this test process and stops itself once it's gone (src/parent-watch.ts). */
const TEST_PID = { QA_TEST_PID: String(process.pid) };

/** The qa command line as a process, on a fake machine (null only for commands that touch no machine, like trace-check). */
export function qaSync(m: TestMachine | null, a: string[], env: Record<string, string> = {}) {
  if (!m && MACHINE_COMMANDS.has(a[0])) throw new Error(`qa ${a[0]} in a test needs a fake machine`);
  return spawnSync(process.execPath, [CLI, ...args(m, a)], { encoding: 'utf8', env: { ...process.env, ...TEST_PID, ...env }, timeout: 120_000 });
}
export function qaSpawn(m: TestMachine, a: string[], o: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, [CLI, ...args(m, a)], { stdio: ['ignore', 'pipe', 'pipe'], ...o, env: { ...process.env, ...TEST_PID, ...(o.env ?? {}) } });
}

/** The same in a terminal of its own (a pseudo-terminal from script(1)), for the attached demo: everything it shows, its
 *  window included, comes on stdout; `type` types into it. script(1) needs a real pipe for its input (on macOS it refuses
 *  the sockets Node gives a child, and a FIFO too), so cat reads the keys from a FIFO into one. The shell exits (with
 *  script's status) only once cat has too: call `close` when the command is done. */
export function qaSpawnInTerminal(m: TestMachine, a: string[], o: SpawnOptions = {}) {
  const keys = join(scratch('qa-terminal-'), 'keys');
  spawnSync('mkfifo', [keys]);
  const command = [process.execPath, CLI, ...args(m, a)];
  const quoted = command.map((w) => `'${w.replace(/'/g, `'\\''`)}'`).join(' ');
  const script = process.platform === 'darwin' ? ['script', '-q', '/dev/null', ...command] : ['script', '-qec', quoted, '/dev/null'];
  const p = spawn('sh', ['-c', 'f=$1; shift; cat "$f" | "$@"', 'sh', keys, ...script], { stdio: ['ignore', 'pipe', 'pipe'], ...o, env: { ...process.env, ...TEST_PID, ...(o.env ?? {}) } });
  const writer = open(keys, 'w');   // resolves once cat reads the FIFO
  let closed: Promise<void> | undefined;
  return { p, type: async (s: string) => { await (await writer).write(s); }, close: () => (closed ??= writer.then((h) => h.close())) };
}

/** The qa command line in a group of its own, stopped when the test finishes (as spawnDetached). */
export const qaDetached = (m: TestMachine, a: string[]): ChildProcess => spawnDetached(process.execPath, [CLI, ...args(m, a)], { env: { ...process.env, ...TEST_PID } });

/** The qa command line left without its parent on purpose: a stand-in parent starts it in a group of its own, says its
 *  pid and exits at once. Returns that pid; the group is killed when the test finishes, whatever it did. */
export function qaOrphaned(m: TestMachine, a: string[]): number {
  const start = `const c = require('child_process').spawn(process.execPath, ${JSON.stringify([CLI, ...args(m, a)])}, { detached: true, stdio: 'ignore', env: { ...process.env, QA_TEST_PID: String(process.pid) } }); console.log(c.pid); c.unref();`;
  const pid = Number(spawnSync(process.execPath, ['-e', start], { encoding: 'utf8', timeout: 30_000 }).stdout.trim());
  if (!(pid > 0)) throw new Error('the stand-in parent never said the pid of qa');
  onTestFinished(() => { stopQaGroup(pid, m.dir); });
  return pid;
}

/** A process's command line, by the system's ps; undefined once it's gone. */
const commandOf = (pid: number): string | undefined => {
  const r = spawnSync(PS, ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
};

/** Kills the group of a qa command line a test started on its own machine `dir` (it isn't this process's child, so its
 *  leader is known by its command line, which names that machine), by the one rule (src/groups.ts): no process holding
 *  its number (only its members can then), or the leader still that command. A number held by any other program (a
 *  leader that exited long ago may have left it to one of the person's own shells), or by one ps can't name, is left
 *  alone. Looked at right before the signal. Returns whether it signalled. */
export function stopQaGroup(pid: number, dir: string, o: { exists?: (pid: number) => boolean; commandOf?: (pid: number) => string | undefined; signal?: (pid: number) => void } = {}): boolean {
  const held = (o.exists ?? exists)(pid);
  const command = held ? (o.commandOf ?? commandOf)(pid) : undefined;
  const leaderRunning = command !== undefined && command.split(/\s+/).some((w, i, all) => w === dir && all[i - 1] === '--fake-machine');
  if (!groupIsOurs(pid, leaderRunning, () => held)) return false;   // held but not named as this qa (ps failing included): fail closed
  (o.signal ?? kill)(-pid);
  return true;
}

/** Only for the guard test: the qa command line in a test process without --fake-machine must refuse to start. */
export const qaBareSync = (a: string[]) => spawnSync(process.execPath, [CLI, ...a], { encoding: 'utf8', env: process.env, timeout: 60_000 });

/** Only behind QA_LIVE=1 (a person's explicit opt-in, spending money): the qa command line on the real machine, as the
 *  live runner, not as a test process (the VITEST settings are removed, so the test tripwire is off in the child). */
export function qaOnRealMachineSync(a: string[], env: Record<string, string> = {}) {
  return nodeOnRealMachineSync(CLI, a, env);
}
/** The same, for a live script under test/live/. */
export function nodeOnRealMachineSync(script: string, a: string[], env: Record<string, string> = {}) {
  if (process.env.QA_LIVE !== '1') throw new Error('the real machine is used only with QA_LIVE=1');
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITEST')));
  return spawnSync(process.execPath, [script, ...a], { encoding: 'utf8', env: { ...clean, ...env }, timeout: 900_000 });
}
