// What a headless Claude Code run leaves outside its sandbox (qa-plan §3.2, measured by the QA plan's spikes), keyed by the
// sandbox path and each session id, so teardown and the janitor remove exactly those and nothing of anyone else's.
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';

/** Where Claude Code keeps per-project and per-session state: `~/.claude` and `/tmp/claude-<uid>`. */
export type Roots = { claudeDir: string; claudeTmp: string };

export function realRoots(): Roots {
  return {
    claudeDir: join(userInfo().homedir, '.claude'),
    claudeTmp: join(realpathSync('/tmp'), `claude-${userInfo().uid}`),   // /private/tmp/claude-<uid> on macOS
  };
}

/** A path as Claude Code names its folders: every character but a letter or a digit becomes "-" (`/`, `.` and `_` alike). */
export const slug = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-');

/** The leftovers of the run whose sandbox is `root`: project and tmp folders named after any path inside it, and each session's env. */
export function assistantLeftovers(root: string, sessions: string[], roots: Roots): string[] {
  const prefix = slug(root);
  const named = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n === prefix || n.startsWith(prefix + '-')).map((n) => join(dir, n)) : []);
  const envs = sessions.map((id) => join(roots.claudeDir, 'session-env', id)).filter((p) => existsSync(p));
  return [...named(join(roots.claudeDir, 'projects')), ...envs, ...named(roots.claudeTmp)];
}
