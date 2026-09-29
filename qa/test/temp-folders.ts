// A run's temporary folders (vitest's globalSetup): every folder a test makes with scratch() (test/machine.ts) is written
// to this run's log, whose path the test workers inherit as QA_SCRATCH_LOG. At the end of the run, any of them that's
// still there fails the run, named: a test that didn't remove it, or a process of a test's that outlived it and made it
// again. The check deletes nothing it didn't make (only its own log).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** How long the check waits after the last test before it looks: a straggler writes within this. */
export const SETTLE_MS = 300;

export default function setup(): () => Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'qa-run-log-'));
  const log = join(dir, 'scratch-folders');
  writeFileSync(log, '');
  process.env['QA_SCRATCH_LOG'] = log;
  return async () => {
    await new Promise((ok) => setTimeout(ok, SETTLE_MS));
    const left = [...new Set(readFileSync(log, 'utf8').split('\n').filter(Boolean))].filter((d) => existsSync(d));
    rmSync(dir, { recursive: true, force: true });   // the log's own folder: this setup made it
    if (left.length) {
      // vitest reports an error thrown here without failing the run, so the run's exit code is set here too
      process.exitCode = 1;
      throw new Error(`${left.length} temporary folder(s) a test made are still there after the run (not removed, or made again by a process that outlived its test); nothing was deleted:\n${left.map((d) => `  ${d}`).join('\n')}`);
    }
  };
}
