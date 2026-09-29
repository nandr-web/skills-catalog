// Whose files and folders setup works in (setup build notes §1 folders, §3 "First, whose files", §9), all read and
// checked before anything is made, so a refusal leaves every folder as it was: Claude Code's settings moved elsewhere
// without SKILLS_ASSISTANT_HOME; root with SUDO_USER; an assistant home or skills home (or, when it's missing, its parent)
// another user owns; a home others can write, or setup can't; .claude or backups/ a link, a file, or not private; the
// record a link, unreadable, or not setup's shape, or naming paths outside setup's own places.

import { accessSync, constants, lstatSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError } from '@skills-catalog/core';
import { readJsonFile, type Snapshot } from './json-file.ts';
import { isPrivate } from './private.ts';
import { elsewhere, recordWhy, type SetupRecord } from './setup-record.ts';

export const RECORD_CAP = 1024 * 1024;

export type SetupPlaces = {
  assistantHome: string;
  claudeDir: string;
  claudeJson: string;
  settingsJson: string;
  skillsHome: string;
  backups: string;
  record: string;
  lock: string;
};
export type PlacesInput = {
  assistantHome: string;
  skillsHome: string;
  /** CLAUDE_CONFIG_DIR, SKILLS_ASSISTANT_HOME and SUDO_USER as setup ran with them. */
  env: Readonly<Record<string, string | undefined>>;
  /** The effective user. */
  uid: number;
};
export type Places = {
  places: SetupPlaces;
  missing: { claudeDir: boolean; skillsHome: boolean; backups: boolean };
  record: SetupRecord | undefined;
  /** What the record file was when read, for writing it back. */
  recordWas: Snapshot | 'absent';
};

const statOr = (path: string, follow: boolean): BigIntStats | undefined => {
  try {
    return (follow ? statSync : lstatSync)(path, { bigint: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CatalogError('target_unavailable', { path });
  }
};
const writable = (path: string) => {
  try {
    accessSync(path, constants.W_OK);
  } catch {
    throw new CatalogError('target_unavailable', { path });
  }
};
const notOwn = (path: string) => new CatalogError('target_not_private', { path, own: false });
const owns = (s: BigIntStats, uid: number) => s.uid === BigInt(uid);

// A folder below a home: absent (setup makes it), or a real, private folder.
function realFolder(path: string, uid: number): boolean {
  const s = statOr(path, false);
  if (!s) return true;
  if (s.isSymbolicLink()) throw new CatalogError('target_symlink', { path });
  if (!s.isDirectory()) throw new CatalogError('exists_untracked', { path });
  if (!isPrivate(s)) throw new CatalogError('target_not_private', { path, own: owns(s, uid) });
  writable(path);
  return false;
}

export function checkPlaces({ assistantHome: A, skillsHome: H, env, uid }: PlacesInput): Places {
  if (env['CLAUDE_CONFIG_DIR'] !== undefined && env['SKILLS_ASSISTANT_HOME'] === undefined) throw new CatalogError('assistant_config_elsewhere', { setting: 'CLAUDE_CONFIG_DIR' });
  // sudo keeps the person's HOME on macOS: setup would write root-owned files Claude Code can't.
  if (uid === 0 && env['SUDO_USER'] !== undefined) throw notOwn(A);

  // The assistant home may itself be a link (as for installs): it's followed.
  const a = statOr(A, true);
  if (!a || !a.isDirectory()) throw new CatalogError('target_unavailable', { path: A });
  if (!owns(a, uid)) throw notOwn(A);
  const h = statOr(H, true);
  const hParent = dirname(H);
  if (!h) {
    const p = statOr(hParent, true);
    if (!p) throw new CatalogError('target_unavailable', { path: hParent });
    if (!owns(p, uid)) throw notOwn(hParent);
  } else if (!owns(h, uid)) throw notOwn(H);
  if (!isPrivate(a)) throw new CatalogError('target_not_private', { path: A, home: true, own: true });
  if (h && !isPrivate(h)) throw new CatalogError('target_not_private', { path: H, own: true });
  writable(A);
  writable(h ? H : hParent);

  // The assistant home's real folder, taken once: every place below is built from it, so each later check (a write's
  // folder identity included) looks at the folder that was checked here, never at a link to it.
  const home = realpathSync(A);
  const places: SetupPlaces = {
    assistantHome: home,
    claudeDir: join(home, '.claude'),
    claudeJson: join(home, '.claude.json'),
    settingsJson: join(home, '.claude', 'settings.json'),
    skillsHome: H,
    backups: join(H, 'backups'),
    record: join(H, 'setup-record.json'),
    lock: join(H, 'setup.lock'),
  };
  const claudeDir = realFolder(places.claudeDir, uid);
  const backups = h ? realFolder(places.backups, uid) : true;

  let record: SetupRecord | undefined;
  let recordWas: Snapshot | 'absent' = 'absent';
  if (h) {
    const bad = (why: string) => new CatalogError('invalid_local_file', { file: 'setup-record.json', why, path: places.record });
    const f = readJsonFile(places.record, RECORD_CAP, { forWrite: true });
    if ('why' in f) throw bad(f.why);
    if ('value' in f) {
      if (recordWhy(f.value)) throw bad('wrong_shape');
      record = f.value as unknown as SetupRecord;
      if (elsewhere(record, places).length) throw bad('wrong_shape');
      recordWas = f.snapshot;
    }
  }
  return { places, missing: { claudeDir, skillsHome: !h, backups }, record, recordWas };
}
