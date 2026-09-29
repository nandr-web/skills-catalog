// A fake machine per test (qa-plan §6.5a, "Tests never reach real roots"): its own tmp (where sandboxes go), a home with
// ~/.claude, and Claude Code's tmp and cache folders, all inside a temporary folder of the test's own. Every test of the clean-run
// machinery passes one explicitly, and the qa command line runs here only with `--fake-machine <dir>`.
// This file is the only test code that starts the qa command line (test/meta.test.ts checks that).
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onTestFinished } from 'vitest';
import { getCurrentTest } from 'vitest/suite';
import { DEFAULT_TOOLS, PS, runProcesses } from '../src/check.ts';
import { exists, groupIsOurs, signalGroup } from '../src/groups.ts';
import { fakeMachine, type Machine } from '../src/machine.ts';
import { RUN_ID } from '../src/safe-delete.ts';
import { sandboxBase } from '../src/sandbox.ts';

/** The budget for a test that starts processes and runs the before/after check (`ps` over every process, `lsof`): a few
 *  seconds each on a busy machine, near vitest's default 5 s. Set per file (vi.setConfig) in the files whose tests do
 *  that, so a plain unit test keeps the default and still fails fast if it hangs. */
export const PROCESS_TEST_MS = 30_000;

// One finisher per test. When the test finishes (after afterEach, and after a failure or a timeout too, where a `finally`
// in the test doesn't run), every process it registered is stopped and its exit awaited, then any process still carrying
// the id of a run in its folders, and only then are its folders removed: no process of the test's outlives its folder
// and makes it again (test/temp-folders.ts names any folder left at the end of the run).
type Finisher = { stops: (() => unknown)[]; folders: string[] };
const finishers = new WeakMap<object, Finisher>();
function finisher(what: string): Finisher {
  const test = getCurrentTest();
  if (!test) throw new Error(`${what} is only for use inside a running test, which cleans it up when it finishes (not at a file's top level or in beforeAll)`);
  const known = finishers.get(test);
  if (known) return known;
  const mine: Finisher = { stops: [], folders: [] };
  finishers.set(test, mine);
  onTestFinished(async () => {
    for (const stop of mine.stops.splice(0).reverse()) {
      try {
        await stop();
      } catch {
        // the next one, and the folders, still go
      }
    }
    try {
      sweep(mine.folders);
    } finally {
      for (const d of mine.folders.splice(0)) rmSync(d, { recursive: true, force: true });   // even when the sweep can't look
    }
  });
  return mine;
}

/** Something to stop before the test's folders go (a child, a server), awaited; the last registered is stopped first. */
export const beforeFoldersGo = (stop: () => unknown): void => void finisher('a process to stop').stops.push(stop);

/** Resolves once the child has exited: listened for from the moment it was started, so an exit already past counts. */
export function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((ok) => {
    if (child.exitCode !== null || child.signalCode !== null) ok();
    else child.once('exit', () => ok());
  });
}

/** A child in a process group of its own, for tests of the process checks. Its whole group is killed when the test
 *  ends, however it ends, and its exit awaited before the test's folders go. */
export function spawnDetached(command: string, args: string[], o: SpawnOptions = {}): ChildProcess {
  const child = spawn(command, args, { stdio: 'ignore', ...o, detached: true });
  const gone = exitOf(child);
  beforeFoldersGo(async () => {
    stopGroup(child);
    await gone;
  });
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

/** Every process still carrying the exact id of a run whose sandbox is in these folders (a test that timed out never
 *  reached its run's teardown), each one looked at again right before the signal; never by name or port. */
function sweep(folders: string[]): void {
  for (const d of folders) for (const id of runsIn(d)) for (const p of runProcesses(id)) if (runProcesses(id).some((q) => q.pid === p.pid)) kill(p.pid);
}

/** From afterEach: the sweep, early. The folders go when the test finishes, after the processes it registered. */
export const cleanup = () => {
  const test = getCurrentTest();
  const mine = test ? finishers.get(test) : undefined;
  if (mine) sweep(mine.folders);
};

/** A temporary folder of the test's own, by its real path. Written to the run's log (test/temp-folders.ts), whose check
 *  at the end of the run names any that's still there. */
export function scratch(prefix = 'qa-test-'): string {
  const mine = finisher('scratch()');
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  mine.folders.push(d);
  const log = process.env['QA_SCRATCH_LOG'];
  if (log) appendFileSync(log, `${d}\n`);
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
  const child = spawn(process.execPath, [CLI, ...args(m, a)], { stdio: ['ignore', 'pipe', 'pipe'], ...o, env: { ...process.env, ...TEST_PID, ...(o.env ?? {}) } });
  const gone = exitOf(child);
  beforeFoldersGo(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');   // through its own handle
    await gone;
  });
  return child;
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
  const gone = exitOf(p);
  beforeFoldersGo(async () => {
    if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');   // through its own handle
    await gone;
  });
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
  beforeFoldersGo(async () => {
    stopQaGroup(pid, m.dir);
    for (let waited = 0; waited < 5000 && exists(pid); waited += 25) await new Promise((ok) => setTimeout(ok, 25));
  });
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
