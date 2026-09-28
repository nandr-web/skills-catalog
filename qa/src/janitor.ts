// The janitor (qa-plan §6.5), before every run: removes runs older than the TTL, with their leftovers, and leftovers whose
// run is gone (by name prefix), once they are older than the TTL.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantLeftovers, realRoots, slug, type Roots } from './leftovers.ts';
import { createdAt, sandboxBase, sessionsOf } from './sandbox.ts';

export const DEFAULT_TTL_MS = 60 * 60_000;

/** Returns what it removed. */
export function janitor({ tmp = tmpdir(), roots = realRoots(), ttlMs = DEFAULT_TTL_MS, now = Date.now }: { tmp?: string; roots?: Roots; ttlMs?: number; now?: () => number } = {}): string[] {
  const base = sandboxBase(tmp);
  const removed: string[] = [];
  const rm = (p: string) => { rmSync(p, { recursive: true, force: true }); removed.push(p); };
  const old = (t: number | undefined) => t !== undefined && now() - t > ttlMs;
  if (existsSync(base)) {
    for (const name of readdirSync(base)) {
      const root = join(base, name);
      if (!old(createdAt(root) ?? statSync(root).mtimeMs)) continue;
      for (const p of assistantLeftovers(root, sessionsOf(root), roots)) rm(p);
      rm(root);
    }
  }
  // Orphans: leftovers named after a qa sandbox whose run folder is gone.
  const prefix = slug(base) + '-';
  for (const dir of [join(roots.claudeDir, 'projects'), roots.claudeTmp]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (name.startsWith(prefix) && old(statSync(p).mtimeMs)) rm(p);
    }
  }
  return removed;
}
