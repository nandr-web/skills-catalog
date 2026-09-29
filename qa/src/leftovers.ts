// What a headless Claude Code run leaves outside its sandbox (the QA plan §3.2, measured in its spikes): a project folder
// and a tmp folder named after the folder it ran in, a session-env folder per session, and, when it starts MCP servers,
// a folder of their logs in Claude Code's cache, named the same way. Removed only at exact paths built from the run's
// own sandbox (the QA plan §6.5a): nothing is ever globbed.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Machine } from './machine.ts';
import { removeLeftover, slug, UnsafeError, UUID } from './safe-delete.ts';
import { DIRS } from './sandbox.ts';

export { slug };
export type Cleanup = { removed: string[]; skipped: { path: string; why: string }[]; kept?: string[] };
export const emptyCleanup = (): Cleanup => ({ removed: [], skipped: [] });

/** The exact folder names a run can leave in ~/.claude/projects, the Claude tmp folder and the Claude cache: the sandbox
 *  and each of its folders. */
export const leftoverNames = (root: string): string[] => [slug(root), ...DIRS.map((d) => slug(join(root, d)))];

/** The folders those names are left in. */
const parentsOn = (m: Machine) => [join(m.roots.claudeDir, 'projects'), m.roots.claudeTmp, m.roots.claudeCache];

/** The exact paths of those names on a machine. */
export const leftoverPaths = (root: string, m: Machine): string[] => parentsOn(m).flatMap((parent) => leftoverNames(root).map((n) => join(parent, n)));

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
  for (const parent of parentsOn(m)) for (const n of leftoverNames(root)) attempt(parent, n, { base, runRoot: root });
  for (const id of sessions) {
    const p = join(m.roots.claudeDir, 'session-env', id);
    if (!UUID.test(id)) { out.skipped.push({ path: p, why: `session id ${JSON.stringify(id)} is not a UUID: not deleted` }); continue; }
    if (o.sessionEnvsBefore!.has(id)) { out.skipped.push({ path: p, why: 'existed before the run: another session\'s, not deleted' }); continue; }
    attempt(join(m.roots.claudeDir, 'session-env'), id);
  }
  return out;
}

const MCP_LOGS = 'mcp-logs-';
const realDir = (p: string) => { try { const st = lstatSync(p); return st.isDirectory() && !st.isSymbolicLink(); } catch { return false; } };

/** The most of one server's log kept with a run (the assistant under test can write there, so its size isn't trusted). */
export const MCP_LOG_MAX_BYTES = 1024 * 1024;

/** Copy each MCP server's log folder (`mcp-logs-<server>/`) from the run's own cache folders into `dest`, before teardown
 *  removes them: dest/mcp-logs-<server>/<file>. Only the exact cache folders named after this run and not there before
 *  it; only regular files, each opened without following a link (a link, or a folder that is one, is reported and
 *  never read). Reading only: deleting is removeRunLeftovers'. */
export function keepMcpLogs(root: string, m: Machine, dest: string, preexisting: ReadonlySet<string>): Pick<Cleanup, 'skipped'> & { kept: string[] } {
  const out = { kept: [] as string[], skipped: [] as Cleanup['skipped'] };
  for (const name of leftoverNames(root)) {
    const folder = join(m.roots.claudeCache, name);
    if (preexisting.has(folder) || !realDir(folder)) continue;
    for (const entry of readdirSync(folder).filter((n) => n.startsWith(MCP_LOGS)).sort()) {
      const logs = join(folder, entry);
      if (!realDir(logs)) { out.skipped.push({ path: logs, why: 'not a real folder (a link is never followed): its logs not kept' }); continue; }
      for (const file of readdirSync(logs).sort()) {
        const from = join(logs, file);
        let fd: number | undefined;
        try {
          // Never waits (a pipe named like a log would block the open), and reads at most MCP_LOG_MAX_BYTES.
          fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const st = fstatSync(fd);
          if (!st.isFile()) throw new Error('not a regular file');
          const head = Buffer.alloc(Math.min(st.size, MCP_LOG_MAX_BYTES));
          let got = 0;
          while (got < head.length) {
            const n = readSync(fd, head, got, head.length - got, got);
            if (n === 0) break;
            got += n;
          }
          const bytes = st.size > MCP_LOG_MAX_BYTES ? Buffer.concat([head.subarray(0, got), Buffer.from(`\n[qa: cut here; the log was ${st.size} bytes]\n`)]) : head.subarray(0, got);
          const to = join(dest, entry, file);
          mkdirSync(join(dest, entry), { recursive: true });
          writeFileSync(to, bytes, { flag: 'wx' });
          out.kept.push(to);
        } catch (e) {
          out.skipped.push({ path: from, why: `not kept (${(e as NodeJS.ErrnoException).code === 'ELOOP' ? 'a link is never followed' : (e as Error).message})` });
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
    }
  }
  return out;
}
