// A sandbox per run (qa-plan §6.2) and the fail-safe (§6.3, contract §8): every path a run writes is resolved first, and
// the run refuses to start if one is under the real home, taken from the OS user record, never from $HOME.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIRS = ['catalog', 'home', 'install', 'assistant', 'work', 'outside', 'bin'] as const;
export type Dir = (typeof DIRS)[number];
export type Sandbox = { runId: string; root: string; dirs: Record<Dir, string>; env: Record<string, string> };

export class FailSafeError extends Error {
  paths: string[];
  constructor(paths: string[], home: string) {
    super(`fail-safe: refusing to run, these paths are under the real home ${home}:\n  ${paths.join('\n  ')}`);
    this.name = 'FailSafeError';
    this.paths = paths;
  }
}

/** The real home, from the OS user record: `HOME` can point anywhere, this can't. */
export const realHome = () => userInfo().homedir;

/** A path with every symlink resolved, even if its last parts don't exist yet. */
export function resolved(path: string): string {
  let head = path;
  const tail: string[] = [];
  while (!existsSync(head)) {
    const up = dirname(head);
    if (up === head) break;
    tail.unshift(basename(head));
    head = up;
  }
  return join(realpathSync(head), ...tail);
}

export function failSafe(paths: string[], home: string = realHome()): void {
  const h = resolved(home);
  const bad = paths.filter((p) => { const r = resolved(p); return r === h || r.startsWith(h + sep); });
  if (bad.length) throw new FailSafeError(bad, h);
}

export const sandboxBase = (tmp: string = tmpdir()) => join(resolved(tmp), 'skills-catalog-qa');

/** Create the run's sandbox, after the fail-safe has passed on every path in it. `home` is for tests of the fail-safe only. */
export function createSandbox({ runId, tmp = tmpdir(), home = realHome(), now = Date.now }: { runId: string; tmp?: string; home?: string; now?: () => number }): Sandbox {
  if (!/^[\w.-]+$/.test(runId)) throw new Error(`run id ${JSON.stringify(runId)}: letters, digits, ".", "-" and "_" only`);
  const root = join(sandboxBase(tmp), runId);
  const dirs = Object.fromEntries(DIRS.map((d) => [d, join(root, d)])) as Record<Dir, string>;
  failSafe([root, ...Object.values(dirs)], home);
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
  writeFileSync(join(root, 'run.json'), JSON.stringify({ runId, createdAt: new Date(now()).toISOString() }) + '\n');
  const env = {
    SKILLS_CATALOG: pathToFileURL(dirs.catalog).href,
    SKILLS_HOME: dirs.home,
    SKILLS_INSTALL_DIR: dirs.install,
    SKILLS_ASSISTANT_HOME: dirs.assistant,
    SKILLS_SYNC_ON_START: '0',
    SKILLS_AS: 'me',
    QA_RUN_ID: runId,
    QA_SANDBOX: root,
    PATH: [dirs.bin, process.env.PATH ?? ''].join(':'),
  };
  return { runId, root, dirs, env };
}

/** Sessions started in this run (assistant session ids), one JSON string per line: any process in the run may append. */
export const recordSession = (sb: { root: string }, id: string) => appendFileSync(join(sb.root, 'sessions.jsonl'), JSON.stringify(id) + '\n');

export function sessionsOf(root: string): string[] {
  const f = join(root, 'sessions.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((s): s is string => typeof s === 'string' && /^[\w-]+$/.test(s));
}

export function createdAt(root: string): number | undefined {
  try { return Date.parse(JSON.parse(readFileSync(join(root, 'run.json'), 'utf8')).createdAt); } catch { return undefined; }
}
