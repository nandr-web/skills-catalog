// What a headless Claude Code run leaves outside its sandbox (the QA plan §3.2, measured in its spikes): a project folder
// and a tmp folder named after the folder it ran in, and a session-env folder per session. Removed only at exact paths
// built from the run's own sandbox (the QA plan §6.5a): nothing is ever globbed.
import { dirname, join } from 'node:path';
import type { Machine } from './machine.ts';
import { removeLeftover, slug, UnsafeError, UUID } from './safe-delete.ts';
import { DIRS } from './sandbox.ts';

export { slug };
export type Cleanup = { removed: string[]; skipped: { path: string; why: string }[] };
export const emptyCleanup = (): Cleanup => ({ removed: [], skipped: [] });

/** The exact folder names a run can leave in ~/.claude/projects and the Claude tmp folder: the sandbox and each of its folders. */
export const leftoverNames = (root: string): string[] => [slug(root), ...DIRS.map((d) => slug(join(root, d)))];

/** The exact paths of those names on a machine. */
export const leftoverPaths = (root: string, m: Machine): string[] =>
  [join(m.roots.claudeDir, 'projects'), m.roots.claudeTmp].flatMap((parent) => leftoverNames(root).map((n) => join(parent, n)));

/** Remove the run's own leftovers, never one that existed before the run started (`preexisting`), and report what was
 *  refused. Session folders only for ids from the run's own stream (`sessions`), when they are UUIDs and weren't there
 *  before the run (`sessionEnvsBefore`, the session-env folder's names before the assistant started). */
export function removeRunLeftovers(root: string, m: Machine, o: { preexisting: ReadonlySet<string>; sessions?: string[]; sessionEnvsBefore?: ReadonlySet<string>; dryRun?: boolean }): Cleanup {
  const sessions = o.sessions ?? [];
  if (sessions.length && !o.sessionEnvsBefore) throw new Error('session ids need sessionEnvsBefore (the session-env names before the run)');
  const out = emptyCleanup();
  const base = dirname(root);
  const attempt = (parent: string, name: string, extra: { base?: string; runRoot?: string } = {}) => {
    const p = join(parent, name);
    if (o.preexisting.has(p)) { out.skipped.push({ path: p, why: 'existed before the run: not this run\'s, not deleted' }); return; }
    try {
      const gone = removeLeftover(parent, name, { ...extra, dryRun: o.dryRun });
      if (gone) out.removed.push(gone);
    } catch (e) {
      if (!(e instanceof UnsafeError) || /tripwire/.test(e.message)) throw e;
      out.skipped.push({ path: p, why: e.message });
    }
  };
  for (const parent of [join(m.roots.claudeDir, 'projects'), m.roots.claudeTmp]) for (const n of leftoverNames(root)) attempt(parent, n, { base, runRoot: root });
  for (const id of sessions) {
    const p = join(m.roots.claudeDir, 'session-env', id);
    if (!UUID.test(id)) { out.skipped.push({ path: p, why: `session id ${JSON.stringify(id)} is not a UUID: not deleted` }); continue; }
    if (o.sessionEnvsBefore!.has(id)) { out.skipped.push({ path: p, why: 'existed before the run: another session\'s, not deleted' }); continue; }
    attempt(join(m.roots.claudeDir, 'session-env'), id);
  }
  return out;
}
