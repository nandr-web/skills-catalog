// The run-wide fail-safe (contract §8), a setup file every test file runs first: whatever a test forgets to sandbox,
// nothing it runs writes under the real home (from the OS user record, not $HOME), Claude Code's own folder there
// (~/.claude), or Claude Code's session folders (/private/tmp/claude-*, /tmp/claude-*). Every file-system call that
// writes, and every SQLite database opened on a file, checks its path first and throws instead. The developer's own
// SKILLS_* settings never reach a test.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, vi } from 'vitest';

// Every refusal is noted, so one the code under test catches (and turns into, say, "unreadable") still fails its test.
// A test that means to be refused takes its refusals with takeRefusals().
const refusals: string[] = [];
function refuse(message: string): never {
  refusals.push(message);
  throw new Error(message);
}
export function takeRefusals(): string[] {
  return refusals.splice(0);
}
/** After each test: fails it when a refusal is left untaken, even one the code caught. */
export function failOnRefusals(): void {
  const left = takeRefusals();
  // A callback that runs late is refused during whichever test is running then, so the refusal may be an earlier test's.
  if (left.length) throw new Error(`fail-safe: ${left.length} refusal(s) during this test, even where caught (this test's, or an earlier test's leftover callback); the first: ${left[0]}`);
}
afterEach(failOnRefusals);

const HOME = userInfo().homedir;
const roots: string[] = [HOME, join(HOME, '.claude')];
const CLAUDE_TMP = /^\/(?:private\/)?tmp\/claude-/;
const { existsSync, realpathSync } = fs;

// A path with its links resolved as far as it exists (/tmp is /private/tmp on a Mac), the rest appended.
function real(path: string): string {
  let head = resolve(path);
  const rest: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    rest.unshift(basename(head));
    head = dirname(head);
  }
  try {
    head = realpathSync(head);
  } catch {
    // keep it as given
  }
  return join(head, ...rest);
}

// The refused place a path is in, or undefined.
export function refusedPlace(path: string): string | undefined {
  const p = real(path);
  for (const root of roots) {
    const r = real(root);
    if (p === r || p.startsWith(r + sep)) return root;
  }
  if (CLAUDE_TMP.test(p) || CLAUDE_TMP.test(resolve(path))) return '/private/tmp/claude-*';
  return undefined;
}

// For this file's own test only: refuse one more folder (a sandbox standing in for a home), to show the guard is on.
export function alsoRefuse(root: string): () => void {
  roots.push(root);
  return () => void roots.splice(roots.indexOf(root), 1);
}

export const REFUSED_ROOTS: readonly string[] = roots;

function check(arg: unknown, call: string): void {
  const path = typeof arg === 'string' ? arg : Buffer.isBuffer(arg) ? arg.toString() : arg instanceof URL ? fileURLToPath(arg) : undefined;
  if (path === undefined) return; // a file descriptor: its path was checked when it was opened
  const place = refusedPlace(path);
  if (place) refuse(`fail-safe: ${call}(${path}) is under ${place}; tests never write there`);
}

const writes = (flags: unknown) => flags !== undefined && !(typeof flags === 'string' && ['r', 'rs', 'sr'].includes(flags)) && flags !== fs.constants.O_RDONLY;

// Each call that writes, and which of its arguments are the paths it writes.
const PATHS: Record<string, number[]> = {
  appendFile: [0], chmod: [0], chown: [0], copyFile: [1], cp: [1], link: [1], lchown: [0], lutimes: [0], mkdir: [0], mkdtemp: [0],
  rename: [0, 1], rm: [0], rmdir: [0], symlink: [1], truncate: [0], unlink: [0], utimes: [0], writeFile: [0],
};

function guard(target: Record<string, any>, name: string, paths: number[], kind: 'sync' | 'callback' | 'promise'): void {
  const fn = target[name];
  if (typeof fn !== 'function') return;
  target[name] = function (this: unknown, ...args: unknown[]) {
    try {
      for (const i of paths) check(args[i], name);
      if (name === 'open' || name === 'openSync') if (writes(args[1])) check(args[0], name);
    } catch (e) {
      if (kind === 'promise') return Promise.reject(e);
      throw e;
    }
    return fn.apply(this, args);
  };
}

for (const [name, paths] of Object.entries(PATHS)) {
  guard(fs, `${name}Sync`, paths, 'sync');
  guard(fs, name, paths, 'callback');
  guard(fs.promises, name, paths, 'promise');
}
guard(fs, 'openSync', [], 'sync');
guard(fs, 'open', [], 'callback');
guard(fs.promises, 'open', [], 'promise');
guard(fs, 'createWriteStream', [0], 'sync');

// Claude Code's real managed settings (contract §8, SKILLS_MANAGED_SETTINGS) and the person's own Claude Code files in the
// real home (~/.claude.json, with the sign-in session and other servers' keys, and ~/.claude): a test never reads them
// either, so one that forgets to point its settings into its sandbox fails instead of reading this machine's.
// /etc is a link to /private/etc on macOS: a path is compared as given and with its links resolved, as refusedPlace does.
const NEVER_READ = ['/Library/Application Support/ClaudeCode', '/etc/claude-code', '/private/etc/claude-code', join(HOME, '.claude.json'), join(HOME, '.claude')];
export const READ_REFUSED: readonly string[] = NEVER_READ;
// For this file's own test only: never read one more folder (a sandbox standing in for ~/.claude), so the checks can
// be shown failing without reading the real one.
export function alsoNeverRead(dir: string): () => void {
  NEVER_READ.push(dir);
  return () => void NEVER_READ.splice(NEVER_READ.indexOf(dir), 1);
}
const pathOf = (arg: unknown) => (typeof arg === 'string' ? arg : Buffer.isBuffer(arg) ? arg.toString() : arg instanceof URL ? fileURLToPath(arg) : undefined);
const readRefusal = (call: string, path: string, place: string) => refuse(`fail-safe: ${call}(${path}) is under ${place}; tests never read the machine's own Claude Code settings`);
function checkRead(arg: unknown, call: string): void {
  const path = pathOf(arg);
  if (path === undefined) return;
  const under = (p: string) => NEVER_READ.find((m) => p === m || p.startsWith(m + sep));
  const place = under(resolve(path)) ?? under(real(path));
  if (place) readRefusal(call, path, place);
}
// glob reads under its folder (options.cwd, else the process's), each pattern of a list, and wherever a wildcard can
// reach: a pattern whose part before its first wildcard holds a refused place, or is above one, is refused.
const WILDCARD = /[*?[\]{}]|[!+@]\(/;
function checkGlob(patterns: unknown, options: unknown, call: string): void {
  const cwd = pathOf((options as { cwd?: unknown } | undefined)?.cwd) ?? process.cwd();
  for (const pattern of Array.isArray(patterns) ? patterns : [patterns]) {
    if (typeof pattern !== 'string') continue;
    const full = resolve(cwd, pattern);
    const parts = full.split(sep);
    const first = parts.findIndex((part) => WILDCARD.test(part));
    if (first < 0) {
      checkRead(full, call);
      continue;
    }
    const prefix = parts.slice(0, first).join(sep) || sep;
    checkRead(prefix, call);
    const above = (p: string) => NEVER_READ.find((m) => m.startsWith(p === sep ? p : p + sep));
    const place = above(prefix) ?? above(real(prefix));
    if (place) readRefusal(call, full, place);
  }
}
function guardRead(target: Record<string, any>, name: string, kind: 'sync' | 'callback' | 'promise'): void {
  const fn = target[name];
  if (typeof fn !== 'function') return;
  const wrap = (inner: (...a: unknown[]) => unknown) =>
    function (this: unknown, ...args: unknown[]) {
      try {
        if (name.startsWith('glob')) checkGlob(args[0], typeof args[1] === 'object' ? args[1] : undefined, name);
        else checkRead(args[0], name);
      } catch (e) {
        if (kind === 'promise') return Promise.reject(e);
        throw e;
      }
      return inner.apply(this, args);
    };
  const wrapped: any = wrap(fn);
  // realpath's native form reads the same places.
  if (typeof fn.native === 'function') wrapped.native = wrap(fn.native);
  target[name] = wrapped;
}
for (const name of ['readFile', 'readdir', 'lstat', 'stat', 'open', 'access', 'opendir', 'readlink', 'realpath', 'statfs', 'copyFile', 'cp', 'glob']) {
  guardRead(fs, `${name}Sync`, 'sync');
  guardRead(fs, name, 'callback');
  // The promises glob hands back an iterator, not a promise: it refuses as it's called.
  guardRead(fs.promises, name, name === 'glob' ? 'sync' : 'promise');
}
for (const name of ['existsSync', 'createReadStream', 'watch', 'watchFile', 'openAsBlob']) guardRead(fs, name, name === 'openAsBlob' ? 'promise' : 'sync');
guardRead(fs.promises, 'watch', 'sync'); // an iterator too

syncBuiltinESMExports(); // `import { writeFileSync } from 'node:fs'` sees the guarded call too

// SQLite opens its files itself, past node:fs, and Node doesn't re-sync node:sqlite's named exports: every module
// the run loads gets a DatabaseSync that checks its file first.
vi.mock('node:sqlite', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:sqlite')>();
  class DatabaseSync extends real.DatabaseSync {
    constructor(path?: string | Buffer | URL, ...rest: any[]) {
      if (path !== undefined && path !== ':memory:') check(path, 'DatabaseSync');
      super(path as string, ...rest);
    }
  }
  return { ...real, default: { ...real, DatabaseSync }, DatabaseSync };
});

for (const key of Object.keys(process.env)) if (key.startsWith('SKILLS_')) delete process.env[key];

// Set before any test file loads, so a test can show the guard was on from the start.
(globalThis as Record<symbol, unknown>)[Symbol.for('skills-catalog.fail-safe')] = true;
