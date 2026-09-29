// A run's temporary folders (vitest's globalSetup): every folder a test makes with scratch() (test/machine.ts) is written
// to this run's log, whose path the test workers inherit as QA_SCRATCH_LOG. At the end of the run, any of them that's
// still there fails the run, named: a test that didn't remove it, or a process of a test's that outlived it and made it
// again. The check deletes nothing it didn't make (only its own log).
//
// Set on each project (vitest.config.ts): vitest runs every project's setup in one process before the first test, and
// every teardown after the last one. The first setup makes the run's log and owns its check; the others find it and do
// nothing. It is marked on globalThis, never found by QA_SCRATCH_LOG, which a run started from a test (the canary's)
// inherits from its parent's.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How long the check waits after the last test before each of its two looks: a process of a test's that makes its
 *  folder again later than twice this after the last test isn't seen. */
export const SETTLE_MS = 300;

const RUN_LOG = Symbol.for('qa.temp-folders.run-log');
type Marked = { [RUN_LOG]?: string };

export default function setup(): () => Promise<void> {
  const g = globalThis as Marked;
  const known = g[RUN_LOG];
  if (known !== undefined) {
    process.env['QA_SCRATCH_LOG'] = known;
    return async () => {};   // the first setup's check covers this project's tests too
  }
  const dir = mkdtempSync(join(tmpdir(), 'qa-run-log-'));
  const log = join(dir, 'scratch-folders');
  writeFileSync(log, '');
  g[RUN_LOG] = log;
  process.env['QA_SCRATCH_LOG'] = log;
  return async () => {
    const left = new Set<string>();
    for (let look = 0; look < 2; look++) {
      await new Promise((ok) => setTimeout(ok, SETTLE_MS));
      for (const d of readFileSync(log, 'utf8').split('\n')) if (d && existsSync(d)) left.add(d);
    }
    delete g[RUN_LOG];
    rmSync(dir, { recursive: true, force: true });   // the log's own folder: this setup made it
    if (left.size) {
      // vitest reports an error thrown here without failing the run, and its summary above still says passed: the
      // run's exit code is set here, and a plain line says so first
      process.exitCode = 1;
      process.stderr.write(`\nFAILED: ${left.size} temporary folder(s) a test made are still there after the run, so the run fails (the summary above counts tests only)\n`);
      throw new Error(`${left.size} temporary folder(s) a test made are still there after the run (not removed, or made again by a process that outlived its test); nothing was deleted:\n${[...left].map((d) => `  ${d}`).join('\n')}`);
    }
  };
}
