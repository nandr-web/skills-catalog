// A run's last line, as `qa run` and `qa demo` print it.
import { checksProcesses } from './check.ts';
import type { RunResult } from './run.ts';

/** Its status, and that nothing was left behind when that's so: in full where the check lists processes (macOS, Linux),
 *  else saying processes weren't checked. */
export function statusLine(name: string, r: Pick<RunResult, 'runId' | 'status' | 'differences'>, platform: NodeJS.Platform = process.platform): string {
  const nothing = checksProcesses(platform) ? ', nothing left behind' : '; files, settings and ports unchanged; processes not checked on this system yet';
  return `qa ${name} ${r.runId}: ${r.status}${r.differences.length ? '' : nothing}`;
}
