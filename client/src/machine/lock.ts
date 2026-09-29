// The installer's own records on this machine (contract §4.5): the lock file, one entry per installed skill keyed by the
// folder it was installed to, and the config's default update policy. Nothing is written into a skill itself. Both files
// sit in SKILLS_HOME (kept 0700), are written whole to a temp file and renamed in, and are readable by the person only.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

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
};

export type Lock = { skills: Record<string, LockEntry> };
export type Config = { update_policy?: Policy; [key: string]: unknown };

const lockFile = (home: string) => join(home, 'lock.json');
const configFile = (home: string) => join(home, 'config.json');

function readJson<T>(file: string, empty: T): T {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw e;
  }
  return JSON.parse(text) as T;
}

function writeJson(home: string, file: string, value: unknown): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

export function readLock(home: string): Lock {
  const lock = readJson<Lock>(lockFile(home), { skills: {} });
  if (typeof lock !== 'object' || lock === null || typeof lock.skills !== 'object' || lock.skills === null) throw new Error(`${lockFile(home)} is not a lock file`);
  return lock;
}

export const writeLock = (home: string, lock: Lock) => writeJson(home, lockFile(home), lock);

export const readConfig = (home: string): Config => readJson<Config>(configFile(home), {});
export const writeConfig = (home: string, config: Config) => writeJson(home, configFile(home), config);

/** The policy a skill updates by: its own, else the default in the config, else automatic. */
export function policyOf(entry: LockEntry | undefined, config: Config): { policy: Policy; source: 'skill' | 'default' } {
  if (entry?.policy) return { policy: entry.policy, source: 'skill' };
  return { policy: config.update_policy ?? POLICY_DEFAULT, source: 'default' };
}
