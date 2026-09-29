// The installer's own records on this machine (contract §4.5): the lock file, one entry per installed skill keyed by the
// folder it was installed to, and the config's default update policy. Nothing is written into a skill itself. Both files
// sit in SKILLS_HOME (kept 0700), are written whole to a temp file and renamed in, and are readable by the person only.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { CatalogError } from '@skills-catalog/core';

export type Policy = 'auto' | 'notify' | 'pin';
export type Target = 'user' | 'project';
export const POLICY_DEFAULT: Policy = 'auto';

/** One acceptance of a held install or update: the version and the kinds of flag the person let through. */
export type Accepted = { version: number; flags: string[] };

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
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
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
