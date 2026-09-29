// A fake machine per test (qa-plan §6.5a, "Tests never reach real roots"): its own tmp (where sandboxes go), a home with
// ~/.claude, and Claude Code's tmp and cache folders, all inside a temporary folder of the test's own. Every test of the clean-run
// machinery passes one explicitly, and the qa command line runs here only with `--fake-machine <dir>`.
// This file is the only test code that starts the qa command line (test/meta.test.ts checks that).
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeMachine, type Machine } from '../src/machine.ts';

/** The budget for a test that starts processes and runs the before/after check (`ps` over every process, `lsof`): a few
 *  seconds each on a busy machine, near vitest's default 5 s. Set per file (vi.setConfig) in the files whose tests do
 *  that, so a plain unit test keeps the default and still fails fast if it hangs. */
export const PROCESS_TEST_MS = 30_000;

const made: string[] = [];
/** Call from afterEach. */
export const cleanup = () => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); };

/** A temporary folder of the test's own, by its real path. */
export function scratch(prefix = 'qa-test-'): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(d);
  return d;
}

export type TestMachine = Machine & { dir: string };
export const machine = (): TestMachine => { const dir = scratch(); return { dir, ...fakeMachine(dir) }; };

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const MACHINE_COMMANDS = new Set(['run', 'janitor', 'agent', 'demo']);
/** qa's own flags go before `--`; --fake-machine goes right after the command's name. */
const args = (m: TestMachine | null, a: string[]) => (m && MACHINE_COMMANDS.has(a[0]) ? [a[0], '--fake-machine', m.dir, ...a.slice(1)] : a);

/** The qa command line as a process, on a fake machine (null only for commands that touch no machine, like trace-check). */
export function qaSync(m: TestMachine | null, a: string[], env: Record<string, string> = {}) {
  if (!m && MACHINE_COMMANDS.has(a[0])) throw new Error(`qa ${a[0]} in a test needs a fake machine`);
  return spawnSync(process.execPath, [CLI, ...args(m, a)], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });
}
export function qaSpawn(m: TestMachine, a: string[], o: SpawnOptions = {}): ChildProcess {
  return spawn(process.execPath, [CLI, ...args(m, a)], { stdio: ['ignore', 'pipe', 'pipe'], ...o, env: { ...process.env, ...(o.env ?? {}) } });
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
  const p = spawn('sh', ['-c', 'f=$1; shift; cat "$f" | "$@"', 'sh', keys, ...script], { stdio: ['ignore', 'pipe', 'pipe'], ...o, env: { ...process.env, ...(o.env ?? {}) } });
  const writer = open(keys, 'w');   // resolves once cat reads the FIFO
  let closed: Promise<void> | undefined;
  return { p, type: async (s: string) => { await (await writer).write(s); }, close: () => (closed ??= writer.then((h) => h.close())) };
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
