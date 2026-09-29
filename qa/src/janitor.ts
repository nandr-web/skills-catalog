// The janitor (the QA plan §6.5 and §6.5a), before every run and as `qa janitor [--dry-run]`: after the fail-safe, in the
// checked base only, it removes finished runs older than the TTL (named by a run id, a real directory, with a run.json
// whose qa process and process groups are gone), with their exact leftovers. It never deletes what it can't tie to a run:
// an entry without run.json (mtime is never a fallback), a leftover whose run folder is gone, a session folder named in a
// sandbox file. Those are reported for a person to look at.
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { emptyCleanup, leftoverNames, removeRunLeftovers, slug, type Cleanup } from './leftovers.ts';
import type { Machine } from './machine.ts';
import { removeRun, RUN_ID, UnsafeError, verifyBase } from './safe-delete.ts';
import { failSafe, readRun, sandboxBase, sessionsOf } from './sandbox.ts';

export const DEFAULT_TTL_MS = 60 * 60_000;

const alive = (pid: number, group = false) => { try { process.kill(group ? -pid : pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };

export function janitor({ machine, ttlMs = DEFAULT_TTL_MS, now = Date.now, dryRun = false }: { machine: Machine; ttlMs?: number; now?: () => number; dryRun?: boolean }): Cleanup {
  const base = sandboxBase(machine.tmp);
  failSafe([base], machine.home);
  const out = emptyCleanup();
  const exists = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  if (!exists(base)) return out;
  verifyBase(base);                                                  // throws, deleting nothing, when the base fails a check
  const skip = (path: string, why: string) => out.skipped.push({ path, why });
  const runs = readdirSync(base);
  for (const name of runs) {
    const root = join(base, name);
    if (!RUN_ID.test(name)) { skip(root, 'not a run id: not deleted'); continue; }
    const st = lstatSync(root);
    if (st.isSymbolicLink() || !st.isDirectory()) { skip(root, 'not a real directory (a link is never followed): not deleted'); continue; }
    const run = readRun(root);
    if (!run || run.run_id !== name) { skip(root, 'no run.json naming this run (mtime is never a fallback): not deleted'); continue; }
    if (alive(run.pid) || run.pgids.some((g) => alive(g, true))) { skip(root, `live run (pid ${run.pid}): kept`); continue; }
    if (now() - Date.parse(run.started_at) <= ttlMs) continue;
    try {
      const left = removeRunLeftovers(root, machine, { preexisting: new Set(run.preexisting), dryRun });
      out.removed.push(...left.removed); out.skipped.push(...left.skipped);
      for (const id of sessionsOf(root)) {
        const env = join(machine.roots.claudeDir, 'session-env', id);
        if (existsSync(env)) skip(env, `named by run ${name}'s sandbox file, so not deleted (a file in a sandbox isn't trusted); remove it by hand if it's that run's`);
      }
      out.removed.push(removeRun(base, name, { dryRun }));
    } catch (e) {
      if (!(e instanceof UnsafeError) || /tripwire/.test(e.message)) throw e;
      skip(root, e.message);
    }
  }
  // Leftovers named like a qa run whose run folder is gone: reported, never deleted (nothing is globbed).
  const owned = new Set(runs.filter((n) => RUN_ID.test(n)).flatMap((n) => leftoverNames(join(base, n))));
  const prefix = slug(base) + '-';
  for (const dir of [join(machine.roots.claudeDir, 'projects'), machine.roots.claudeTmp]) {
    if (!existsSync(dir)) continue;
    for (const n of readdirSync(dir)) if (n.startsWith(prefix) && !owned.has(n) && !out.removed.includes(join(dir, n))) skip(join(dir, n), 'its run folder is gone: not deleted (nothing is globbed); remove it by hand');
  }
  return out;
}
