// Setup's record, $SKILLS_HOME/setup-record.json (setup build notes, "The record"): each entry setup added, exactly as
// written, so teardown removes only what deep-equals it; the files setup created from nothing; and the backups it made.
// A record that isn't this shape proves nothing, so it's refused whole, never read in part.

import { isAbsolute } from 'node:path';
import { isCopyIdentity } from './lock.ts';

export const RECORD_VERSION = 1;
export type EntryKind = 'mcp_entry' | 'hook_group' | 'allow_rule';
/** A container setup made because it wasn't there, by its dotted path in the file. */
export type Container = 'mcpServers' | 'hooks' | 'hooks.SessionStart' | 'permissions' | 'permissions.allow';
export type RecordEntry = {
  kind: EntryKind;
  /** The assistant file's absolute path. */
  file: string;
  /** The value as written: the MCP entry and the hook group are objects, an allow rule is its text. */
  value: unknown;
  /** pending: listed before the file is written; written: after (a crash leaves more listed, never less). */
  state: 'pending' | 'written';
  /** An allow rule only: already in the list, so teardown never removes it. */
  was_there?: boolean;
  created?: Container[];
};
export type SetupRecord = {
  version: 1;
  /** SKILLS_SETUP_ID: 128 random bits in hex, in the MCP entry's env and the hook's line. */
  setup_id: string;
  entries: RecordEntry[];
  /** Files setup made from nothing, with the sha256 of the bytes it wrote (deleted by teardown only when still those). */
  created_files: { file: string; sha256: string }[];
  /** Each copy made before a change: the file it copies, where the copy is, its sha256 and its identity. */
  backups: { file: string; path: string; sha256: string; dev: number | string; ino: number | string; birth: number | string }[];
};

// Which containers each kind of entry can make.
const CONTAINERS: Record<EntryKind, readonly Container[]> = {
  mcp_entry: ['mcpServers'],
  hook_group: ['hooks', 'hooks.SessionStart'],
  allow_rule: ['permissions', 'permissions.allow'],
};
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const onlyKeys = (x: Record<string, unknown>, keys: readonly string[]) => Object.keys(x).every((k) => keys.includes(k));
const isPath = (x: unknown) => typeof x === 'string' && isAbsolute(x);
const isHash = (x: unknown) => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x);

function isEntry(e: unknown): boolean {
  if (!isObject(e) || !onlyKeys(e, ['kind', 'file', 'value', 'state', 'was_there', 'created'])) return false;
  const kind = e['kind'] as EntryKind;
  if (!Object.hasOwn(CONTAINERS, kind) || !isPath(e['file']) || !['pending', 'written'].includes(e['state'] as string)) return false;
  if (kind === 'allow_rule' ? typeof e['value'] !== 'string' || typeof e['was_there'] !== 'boolean' : !isObject(e['value']) || e['was_there'] !== undefined) return false;
  const created = e['created'];
  if (created === undefined) return true;
  return Array.isArray(created) && new Set(created).size === created.length && created.every((c) => CONTAINERS[kind].includes(c as Container));
}

/** Why the record can't be used, if it can't: wrong_shape for anything but the shape above. */
export function recordWhy(x: unknown): 'wrong_shape' | undefined {
  if (!isObject(x) || !onlyKeys(x, ['version', 'setup_id', 'entries', 'created_files', 'backups'])) return 'wrong_shape';
  if (x['version'] !== RECORD_VERSION || typeof x['setup_id'] !== 'string' || !/^[0-9a-f]{32}$/.test(x['setup_id'])) return 'wrong_shape';
  const { entries, created_files: created, backups } = x;
  if (!Array.isArray(entries) || !entries.every(isEntry)) return 'wrong_shape';
  if (!Array.isArray(created) || !created.every((f) => isObject(f) && onlyKeys(f, ['file', 'sha256']) && isPath(f['file']) && isHash(f['sha256']))) return 'wrong_shape';
  const isBackup = (b: unknown) => isObject(b) && onlyKeys(b, ['file', 'path', 'sha256', 'dev', 'ino', 'birth']) && isPath(b['file']) && isPath(b['path']) && isHash(b['sha256']) && b['birth'] !== undefined && isCopyIdentity(b);
  if (!Array.isArray(backups) || !backups.every(isBackup)) return 'wrong_shape';
  return undefined;
}
