// The installer's own records on this machine (contract §4.5): the lock file, one entry per installed skill keyed by the
// folder it was installed to, and the config's default update policy. Nothing is written into a skill itself. Both files
// sit in SKILLS_HOME (kept 0700), are written whole to a temp file and renamed in, and are readable by the person only.

import { spawnSync } from 'node:child_process';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CatalogError } from '@skills-catalog/core';

export type Policy = 'auto' | 'notify' | 'pin';
export type Target = 'user' | 'project';
export const POLICY_DEFAULT: Policy = 'auto';

/** One acceptance of a held install or update: the version and the kinds of flag the person let through. */
// `by`: set when the person's accept_flagged_updates let it through (§5.3), absent for their yes to a hold.
export type Accepted = { version: number; flags: string[]; by?: 'accept_flagged_updates' };

export type LockEntry = {
  name: string;
  target: Target;
  version: number;
  fingerprint: string;
  publisher: string;
  /** This skill's own policy; none means the default. */
  policy?: Policy;
  /** For people to read: the installer always computes where a skill goes from its target and name. */
  path: string;
  installed_at: string;
  catalog: string;
  accepted: Accepted[];
  /** The installed folder's identity on disk when it was written; a replace deletes the old folder only if it still
   *  matches. Entries written before it was kept have none, and their replaced folder is kept, never deleted. */
  copy?: FolderId;
};

/** Each part is a number while it's a safe integer, and past 2^53 a decimal string of digits, so it's kept exactly. */
export type FolderId = { dev: number | string; ino: number | string; birth?: number | string };

export type Lock = { skills: Record<string, LockEntry> };
export type Config = { update_policy?: Policy; [key: string]: unknown };

const lockFile = (home: string) => join(home, 'lock.json');
const configFile = (home: string) => join(home, 'config.json');

// A file that isn't JSON, has the wrong shape (a wrong-typed field anywhere) or names an unknown policy is refused with
// invalid_local_file {file, why, path}: never repaired or rewritten, and an unknown policy never taken as automatic.
type Why = 'wrong_shape' | 'unknown_policy';
const POLICIES: readonly string[] = ['auto', 'notify', 'pin'];
const TARGETS: readonly string[] = ['user', 'project'];

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isCount = (x: unknown) => Number.isSafeInteger(x) && (x as number) >= 1;
const isStrings = (x: unknown) => Array.isArray(x) && x.every((y) => typeof y === 'string');

/** Why a policy field is refused, if it is: absent is fine; a string that isn't a policy is unknown; anything else is the wrong shape. */
const policyWhy = (x: unknown): Why | undefined => (x === undefined ? undefined : typeof x !== 'string' ? 'wrong_shape' : POLICIES.includes(x) ? undefined : 'unknown_policy');

// A part of a folder's identity: a non-negative safe integer, or a decimal string of digits (no sign, no leading zeros).
const isIdPart = (n: unknown) => (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) || (typeof n === 'string' && /^(0|[1-9][0-9]*)$/.test(n));

function entryWhy(e: unknown): Why | undefined {
  if (!isObject(e)) return 'wrong_shape';
  const strings = ['name', 'fingerprint', 'publisher', 'path', 'installed_at', 'catalog'].every((k) => typeof e[k] === 'string');
  const accepted = Array.isArray(e['accepted']) && e['accepted'].every((a) => isObject(a) && isCount(a['version']) && isStrings(a['flags']));
  const c = e['copy'];
  const copy = c === undefined || (isObject(c) && [c['dev'], c['ino']].every(isIdPart) && (c['birth'] === undefined || isIdPart(c['birth']) || (typeof c['birth'] === 'number' && Number.isFinite(c['birth']) && c['birth'] > 0)));
  if (!strings || !TARGETS.includes(e['target'] as string) || !isCount(e['version']) || !accepted || !copy) return 'wrong_shape';
  return policyWhy(e['policy']);
}

function lockWhy(x: unknown): Why | undefined {
  if (!isObject(x) || !isObject(x['skills'])) return 'wrong_shape';
  const whys = Object.values(x['skills']).map(entryWhy);
  return whys.includes('wrong_shape') ? 'wrong_shape' : whys.find((w) => w !== undefined);
}

const configWhy = (x: unknown): Why | undefined => (isObject(x) ? policyWhy(x['update_policy']) : 'wrong_shape');

function readJson<T>(home: string, name: 'lock.json' | 'config.json', empty: T, why: (x: unknown) => Why | undefined): T {
  const path = join(home, name);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw e;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CatalogError('invalid_local_file', { file: name, why: 'not_json', path });
  }
  const refused = why(value);
  if (refused) throw new CatalogError('invalid_local_file', { file: name, why: refused, path });
  return value as T;
}

function writeJson(home: string, file: string, value: unknown): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  // On disk before it's renamed over the file, so a crash leaves the old file or the whole new one, never an empty one.
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export const readLock = (home: string): Lock => readJson<Lock>(home, 'lock.json', { skills: {} }, lockWhy);

export const writeLock = (home: string, lock: Lock) => writeJson(home, lockFile(home), lock);

export const readConfig = (home: string): Config => readJson<Config>(home, 'config.json', {}, configWhy);

/** Both files, checked: every installer call reads both first, so a damaged one refuses the call before anything changes. */
export function readRecords(home: string): { lock: Lock; config: Config } {
  return { lock: readLock(home), config: readConfig(home) };
}
export const writeConfig = (home: string, config: Config) => writeJson(home, configFile(home), config);

/** The policy a skill updates by: its own, else the default in the config, else automatic. */
export function policyOf(entry: LockEntry | undefined, config: Config): { policy: Policy; source: 'skill' | 'default' } {
  if (entry?.policy) return { policy: entry.policy, source: 'skill' };
  return { policy: config.update_policy ?? POLICY_DEFAULT, source: 'default' };
}

// ---------- one writer at a time (§4.5) ----------

/** How long a run waits for another run's lock before it refuses with lock_busy. */
export const LOCK_WAIT_MS = 5000;
const LOCK_RETRY_MS = 50;
// A process's start as `ps` reports it has whole seconds; a holder's start within this of it is the same process.
const SAME_START_MS = 2000;

type Holder = { pid: number; started: number };
let myStart: number | undefined;
/** This process's start as another run reads it: from `ps`, the same clock it's compared on (on Linux, process.uptime()
 *  doesn't count time asleep and `ps` does, so a server running since before a suspend would look stale). Read once;
 *  process.uptime() only when `ps` can't tell. */
const startedHere = () => (myStart ??= startOf(process.pid) ?? Date.now() - Math.round(process.uptime() * 1000));
// Waits without blocking: the MCP server answers other calls meanwhile.
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
function lstatOr(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** When a process started, from `ps` (macOS and Linux), or undefined when it can't tell. Read as the time since it started
 *  ([[dd-]hh:]mm:ss), which has no time zone: a start printed as a local time would be parsed in this run's zone, and a
 *  live holder taken for a stale one. */
function startOf(pid: number): number | undefined {
  // The system's ps by its full path: a `ps` earlier on the person's PATH (a project's node_modules/.bin) never runs.
  const r = spawnSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 2000 });
  return startFromEtime(r.stdout ?? '', Date.now());
}

/** A start from `ps`'s etime output ([[dd-]hh:]mm:ss) at `now`, or undefined when it isn't one. */
export function startFromEtime(etime: string, now: number): number | undefined {
  const m = /^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return undefined;
  const [days, hours, minutes, seconds] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0)) as [number, number, number, number];
  return now - (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** A file's text, read without following a link, or undefined when it can't be read. */
function textOf(path: string): string | undefined {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** The lock file as found: its stat (never through a link), its text, and who holds it, when that can be read. */
function heldBy(path: string): { st: Stats; text?: string; holder?: Holder } | undefined {
  const st = lstatOr(path);
  if (!st) return undefined;
  if (!st.isFile()) return { st };
  const text = textOf(path);
  try {
    const h = JSON.parse(text ?? '');
    return Number.isSafeInteger(h?.pid) && h.pid > 0 && Number.isFinite(h?.started) ? { st, text, holder: { pid: h.pid, started: h.started } } : { st, text };
  } catch {
    return { st, text };
  }
}

/** A lock whose holder is gone, or whose process id now belongs to a process started at another time; one whose holder
 *  can't be read (a run stopped between making it and writing it) once it's older than the wait; and one naming this
 *  very process that no hold of this process has (heldHere), which it left behind (a pid reused after a crash). */
function isStale(found: { st: Stats; holder?: Holder }): boolean {
  if (!found.st.isFile()) return false;
  const h = found.holder;
  if (!h) return Date.now() - found.st.mtimeMs > LOCK_WAIT_MS;
  if (h.pid === process.pid) return true;
  try {
    process.kill(h.pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true;
  }
  const started = startOf(h.pid);
  return started !== undefined && Math.abs(started - h.started) > SAME_START_MS;
}

/** Removes the lock file only while it's the same file, a regular one owned by this user, unchanged since it was looked at:
 *  the same inode, change and birth times, and (when it was read) the same text. A file replaced or written over in
 *  between, even on a reused inode, is someone else's lock now. */
function removeIfSame(path: string, was: Stats, text?: string): boolean {
  const st = lstatOr(path);
  if (!st || !st.isFile() || st.dev !== was.dev || st.ino !== was.ino || st.uid !== process.getuid?.()) return false;
  if (st.ctimeMs !== was.ctimeMs || st.birthtimeMs !== was.birthtimeMs) return false;
  if (text !== undefined && textOf(path) !== text) return false;
  unlinkSync(path);
  return true;
}

// Lock files a hold of this process has (an update holds one across awaits). One hold at a time: another call of this
// process waits for its release like another run would. A file is marked here in the same synchronous step that makes
// it, so no call can find the file and not the mark; only a lock file of this process that isn't held here is one it
// left behind.
const heldHere = new Set<string>();

/** Makes the lock file, holding this process's id and start, and marks it held here, all in one synchronous step; undefined
 *  when a lock file is already there. A file whose holder couldn't be written is removed again, never left empty. */
function create(path: string): Stats | undefined {
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
    throw e;
  }
  try {
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, started: startedHere() }));
    } catch (e) {
      const made = fstatSync(fd);
      const there = lstatOr(path);
      if (there && there.dev === made.dev && there.ino === made.ino) unlinkSync(path);
      throw e;
    }
    const mine = fstatSync(fd);
    heldHere.add(path);
    return mine;
  } finally {
    closeSync(fd);
  }
}

/** Takes $SKILLS_HOME/lock.json.lock: made only if absent. A lock held by another run, or by another call of this process,
 *  is waited for up to 5 seconds, then lock_busy {path, pid}; a stale one is removed and taken. */
async function take(path: string, now: () => number): Promise<Stats> {
  const deadline = now() + LOCK_WAIT_MS;
  for (;;) {
    let pid: number | null = process.pid;
    if (!heldHere.has(path)) {
      const mine = create(path);
      if (mine) return mine;
      const found = heldBy(path);
      // Gone since the try, or stale and removed: tried again at once, but only within the same wait.
      const again = !found || (isStale(found) && removeIfSame(path, found.st, found.text));
      if (again && now() < deadline) continue;
      // Only this user's regular file names a holder; a link, anything else or another user's file is named by its path.
      pid = found && !again && found.st.isFile() && found.st.uid === process.getuid?.() ? (found.holder?.pid ?? null) : null;
    }
    if (now() >= deadline) throw new CatalogError('lock_busy', { path, pid });
    await wait(LOCK_RETRY_MS);
  }
}

/** One run's changes to lock.json (§4.5, one writer at a time): the lock file is taken at the first change and held until
 *  `release`, so a run with several changes (an update of several skills) holds it from its first write to its end, and
 *  lock_busy always means nothing was changed. Each change reads lock.json afresh, changes it (it may wait, for a read of
 *  the catalog: no other run or call of this process writes meanwhile), and writes it back whole (a temp file renamed over
 *  it, so a reader sees the whole old or new file). `now` is the clock a wait is measured by. */
export function holdLock(home: string, now: () => number): { change<T>(fn: (lock: Lock) => T | Promise<T>): Promise<T>; release(): void } {
  const path = join(home, 'lock.json.lock');
  let mine: Stats | undefined;
  return {
    async change<T>(fn: (lock: Lock) => T | Promise<T>): Promise<T> {
      mkdirSync(home, { recursive: true, mode: 0o700 });
      mine ??= await take(path, now);
      const lock = readLock(home);
      const was = JSON.stringify(lock);
      const out = await fn(lock);
      // A change that decided to change nothing (a hold) leaves lock.json as it is.
      if (JSON.stringify(lock) !== was) writeLock(home, lock);
      return out;
    },
    release(): void {
      if (!mine) return;
      heldHere.delete(path);
      removeIfSame(path, mine);
      mine = undefined;
    },
  };
}

/** One change to lock.json under the lock, which is removed afterwards whether the change succeeded or not. */
export async function withLock<T>(home: string, now: () => number, change: (lock: Lock) => T | Promise<T>): Promise<T> {
  const hold = holdLock(home, now);
  try {
    return await hold.change(change);
  } finally {
    hold.release();
  }
}
