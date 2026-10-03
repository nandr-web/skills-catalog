// Setup's record, $SKILLS_HOME/setup-record.json (setup build notes, "The record"): each entry setup added, exactly as
// written, so teardown removes only what deep-equals it; the files setup created from nothing; and the backups it made.
// A record that isn't this shape proves nothing, so it's refused whole, never read in part.

import { basename, isAbsolute, join } from 'node:path';
import { isCopyIdentity } from './lock.ts';
import { isOwnHookGroup, isOwnMcpEntry } from './setup-values.ts';

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
  // Each value is exactly one setup builds with this setup id (the MCP entry from its own command, script and settings;
  // the hook group from its line, read back whole), never one that merely contains the id.
  const id = x['setup_id'] as string;
  if (!entries.every((e: RecordEntry) => (e.kind === 'mcp_entry' ? isOwnMcpEntry(e.value, id) : e.kind === 'hook_group' ? isOwnHookGroup(e.value, id) : true))) return 'wrong_shape';
  return undefined;
}

/** Where setup writes, rebuilt from its own settings, never taken from the record. */
export type Places = { claudeJson: string; settingsJson: string; backups: string; command: string };
const FILE_OF: Record<EntryKind, keyof Places> = { mcp_entry: 'claudeJson', hook_group: 'settingsJson', allow_rule: 'settingsJson' };
const BACKUP_NAME = /^\d{8}T\d{6}Z-[0-9a-f]{4}-(claude\.json|settings\.json)$/;

/** Every path the record names outside setup's own places, in the record's order, once each: an entry in a file other
 *  than its kind's, a created file that isn't one of the two or the terminal's launcher, a backup's original that isn't
 *  one of the two, a copy that isn't in the backups
 *  folder under the name setup gives it. Setup refuses such a record; teardown never opens or deletes those paths. */
export function elsewhere(r: SetupRecord, p: Places): string[] {
  const files = [p.claudeJson, p.settingsJson];
  const out = [
    ...r.entries.filter((e) => e.file !== p[FILE_OF[e.kind]]).map((e) => e.file),
    ...r.created_files.filter((f) => !files.includes(f.file) && f.file !== p.command).map((f) => f.file),
    ...r.backups.filter((b) => !files.includes(b.file)).map((b) => b.file),
    ...r.backups.filter((b) => b.path !== join(p.backups, basename(b.path)) || !BACKUP_NAME.test(basename(b.path)) || !basename(b.path).endsWith(b.file === p.claudeJson ? '-claude.json' : '-settings.json')).map((b) => b.path),
  ];
  return [...new Set(out)];
}
