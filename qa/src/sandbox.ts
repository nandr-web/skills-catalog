// A sandbox per run (the QA plan §6.2) and the fail-safe (§6.3; the contract §8): every path a run writes is resolved
// first, and the run refuses to start if one is under the real home, taken from the OS user record, never from $HOME.
// Sandboxes live in one base directory, created 0700 and checked before use (§6.5a); each run's folder is named by its
// run id and holds run.json {run_id, pid, started_at, pgids, preexisting}, which the janitor reads.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { leftoverPaths } from './leftovers.ts';
import type { Machine } from './machine.ts';
import { BASE_NAME, canonical, ensureBase, realHome, RUN_ID, tripwire, UnsafeError, within } from './safe-delete.ts';

export { realHome };
export const DIRS = ['catalog', 'home', 'install', 'assistant', 'work', 'outside', 'bin'] as const;
export type Dir = (typeof DIRS)[number];
export type Sandbox = { runId: string; root: string; dirs: Record<Dir, string>; env: Record<string, string>; preexisting: ReadonlySet<string> };
export type RunRecord = { run_id: string; pid: number; started_at: string; pgids: number[]; preexisting: string[] };

export class FailSafeError extends Error {
  paths: string[];
  constructor(paths: string[], home: string) {
    super(`fail-safe: refusing to run, these paths are under the home ${home}:\n  ${paths.join('\n  ')}`);
    this.name = 'FailSafeError';
    this.paths = paths;
  }
}

/** Refuse any path under the real home, and under `alsoHome` when given (a fake machine's home): never instead of it. */
export function failSafe(paths: string[], alsoHome?: string): void {
  for (const home of [realHome(), ...(alsoHome ? [alsoHome] : [])]) {
    const h = canonical(home);
    const bad = paths.filter((p) => within(canonical(p), h));
    if (bad.length) throw new FailSafeError(bad, h);
  }
}

export const sandboxBase = (tmp: string) => join(canonical(tmp), BASE_NAME);

/** The environment every process a run starts gets (the QA plan §6 step 3): these names from the parent, then the
 *  sandbox's own SKILLS_* and QA_* settings. Tokens and keys (AWS, GitHub, Anthropic, npm, SSH) never pass. The assistant
 *  keeps the real HOME: its login lives there (the one documented exception). */
export const ENV_ALLOW = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_*', 'TERM', 'SKILLS_*', 'QA_*'];
/** The runner plants a marker under these names in the parent environment of every assistant run: credential names and
 *  an ordinary one. The safety rule no_env_marker_in checks it never shows. */
export const PLANTED_NAMES = ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK', 'MY_NOTES'];
const allowedName = (k: string) => ENV_ALLOW.some((a) => (a.endsWith('*') ? k.startsWith(a.slice(0, -1)) : k === a));
export function childEnv(sb: { env: Record<string, string> }, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const kept = Object.entries(parent).filter((e): e is [string, string] => typeof e[1] === 'string' && allowedName(e[0]));
  return { ...Object.fromEntries(kept), ...sb.env };
}

/** run.json is written whole: a temp file, then a rename. */
const writeRun = (root: string, r: RunRecord) => {
  const tmp = join(root, `.run.json.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(r) + '\n');
  renameSync(tmp, join(root, 'run.json'));
};

/** A run id: the UTC time and 8 random hex digits, e.g. 20260929T001234Z-1a2b3c4d. */
export const newRunId = (now: Date = new Date()) => `${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(4).toString('hex')}`;

/** Create the run's sandbox, after the fail-safe has passed on every path in it and the base has passed its checks. */
export function createSandbox({ runId, machine, now = Date.now }: { runId: string; machine: Machine; now?: () => number }): Sandbox {
  if (!RUN_ID.test(runId)) throw new UnsafeError(`run id ${JSON.stringify(runId)}: must look like 20260929T001234Z-1a2b3c4d`);
  const base = sandboxBase(machine.tmp);
  const root = join(base, runId);
  if (dirname(root) !== base) throw new UnsafeError(`run folder ${root} is not directly in ${base}`);
  const dirs = Object.fromEntries(DIRS.map((d) => [d, join(root, d)])) as Record<Dir, string>;
  failSafe([base, root, ...Object.values(dirs)], machine.home);
  tripwire(root, 'create');
  ensureBase(base);
  mkdirSync(root, { mode: 0o700 });
  for (const d of Object.values(dirs)) mkdirSync(d);
  // Leftover names can't exist before a new run; if one does, it isn't this run's, and teardown never deletes it.
  const preexisting = leftoverPaths(root, machine).filter((p) => existsSync(p));
  const record: RunRecord = { run_id: runId, pid: process.pid, started_at: new Date(now()).toISOString(), pgids: [], preexisting };
  writeRun(root, record);
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
  return { runId, root, dirs, env, preexisting: new Set(preexisting) };
}

export function readRun(root: string): RunRecord | undefined {
  try {
    const r = JSON.parse(readFileSync(join(root, 'run.json'), 'utf8'));
    return typeof r.run_id === 'string' && Number.isInteger(r.pid) && typeof r.started_at === 'string' ? { pgids: [], preexisting: [], ...r } : undefined;
  } catch { return undefined; }
}

/** The run's process groups go into run.json, so the janitor never takes a run whose processes still live. */
export function recordProcessGroup(sb: { root: string }, pgid: number): void {
  const r = readRun(sb.root);
  if (r) writeRun(sb.root, { ...r, pgids: [...r.pgids, pgid] });
}

/** Sessions an assistant run started, for the janitor's report only: a file in the sandbox is never trusted for deletion. */
export const recordSession = (sb: { root: string }, id: string) => appendFileSync(join(sb.root, 'sessions.jsonl'), JSON.stringify(id) + '\n');

export function sessionsOf(root: string): string[] {
  const f = join(root, 'sessions.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((s): s is string => typeof s === 'string');
}
