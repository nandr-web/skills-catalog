// Which machine a qa run acts on: its tmp folder (where sandboxes go), the home the fail-safe and the before/after check
// watch, and Claude Code's two folders (~/.claude and /private/tmp/claude-<uid>). Every function that creates, checks or
// deletes takes one explicitly. Only the command line picks the real machine; tests use fake ones (the QA plan §6.5a).
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testPid, watchParent } from './parent-watch.ts';
import { canonical, inTestProcess, realClaudeTmp, realHome, UnsafeError } from './safe-delete.ts';
import { failSafe } from './sandbox.ts';

/** Where Claude Code keeps per-project and per-session state: `~/.claude` and `/private/tmp/claude-<uid>`. */
export type Roots = { claudeDir: string; claudeTmp: string };
export type Machine = { tmp: string; home: string; roots: Roots };

/** The real machine. Refused in a test process: tests pass a fake one, or --fake-machine to the command line. */
export function realMachine(): Machine {
  if (inTestProcess()) throw new UnsafeError('the real machine is never used by a test process (the QA plan §6.5a): pass a fake machine, or --fake-machine <dir> to the qa command line');
  const home = realHome();
  return { tmp: tmpdir(), home, roots: { claudeDir: join(home, '.claude'), claudeTmp: realClaudeTmp() } };
}

/** The command line's machine: a fake one for --fake-machine <dir> (a test started it, so it watches that test's process
 *  and stops itself, as SIGTERM stops it, once the test is gone), else the real one, which is never watched. */
export function machineFor(fake: string | undefined, o: { watch?: typeof watchParent; real?: () => Machine } = {}): Machine {
  if (!fake) return (o.real ?? realMachine)();
  const m = fakeMachine(fake);
  (o.watch ?? watchParent)(() => process.kill(process.pid, 'SIGTERM'), { pid: testPid() });
  return m;
}

/** A fake machine in `dir`: dir/tmp, dir/home (with .claude/{skills,projects,session-env}) and dir/claude-tmp. */
export function fakeMachine(dir: string): Machine {
  const root = canonical(dir);
  failSafe([root]);
  const m: Machine = { tmp: join(root, 'tmp'), home: join(root, 'home'), roots: { claudeDir: join(root, 'home', '.claude'), claudeTmp: join(root, 'claude-tmp') } };
  for (const d of [m.tmp, join(m.roots.claudeDir, 'skills'), join(m.roots.claudeDir, 'projects'), join(m.roots.claudeDir, 'session-env'), m.roots.claudeTmp]) mkdirSync(d, { recursive: true });
  return m;
}
