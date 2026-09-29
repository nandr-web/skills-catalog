// A skill's files as bytes, and the rules every file list obeys (contract §4.2, §4.3). Shared by the catalog core and
// the installer, so a tree is checked and fingerprinted the same way on both sides.

import { createHash } from 'node:crypto';
import { CatalogError } from './errors.ts';

export type Mode = '0644' | '0755';
export const MODES: readonly Mode[] = ['0644', '0755'];

export interface TreeFile {
  path: string; // NFC, relative, '/'-separated
  mode: Mode;
  bytes: Uint8Array;
}

export interface FileEntry {
  path: string;
  mode: Mode;
  sha256: string; // hex
  size: number;
}

export interface Limits {
  files: number;
  file_bytes: number;
  skill_bytes: number;
}

// Config, not code (contract §4.2): the defaults.
export const DEFAULT_LIMITS: Limits = { files: 100, file_bytes: 1024 * 1024, skill_bytes: 5 * 1024 * 1024 };

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function entryOf(f: TreeFile): FileEntry {
  return { path: f.path, mode: f.mode, sha256: sha256Hex(f.bytes), size: f.bytes.byteLength };
}

function byPathBytes(a: { path: string }, b: { path: string }): number {
  return Buffer.compare(Buffer.from(a.path, 'utf8'), Buffer.from(b.path, 'utf8'));
}

export function sortEntries<T extends { path: string }>(entries: readonly T[]): T[] {
  return [...entries].sort(byPathBytes);
}

// Contract §4.3: for each file, sorted by path (bytewise, NFC UTF-8): "<mode> <sha256 of bytes> <path>\n".
export function fingerprint(entries: readonly { path: string; mode: Mode; sha256: string }[]): string {
  const listing = sortEntries(entries)
    .map((e) => `${e.mode} ${e.sha256} ${e.path}\n`)
    .join('');
  return 'sha256:' + sha256Hex(Buffer.from(listing, 'utf8'));
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
// Invisible format characters (bidi overrides, zero-width joiners and spaces): a path that reads as one thing and is
// another.
const INVISIBLE = /\p{Cf}/u;
export const MAX_PATH_BYTES = 1024;
export const MAX_SEGMENT_BYTES = 255;

// Why a path is refused, as a code; the words for each are in the agent-facing surface (errors.why).
export type PathWhy =
  | 'empty'
  | 'not_utf8'
  | 'control_character'
  | 'invisible_character'
  | 'backslash'
  | 'absolute'
  | 'empty_segment'
  | 'dot_segment'
  | 'git_folder'
  | 'segment_too_long'
  | 'too_long'
  | 'bad_mode'
  | 'duplicate'
  | 'case_clash'
  | 'file_is_folder';

function refuse(path: string, why: PathWhy, extra: Record<string, unknown> = {}): never {
  throw new CatalogError('invalid_path', { path, why, ...extra });
}

// One path: returns its NFC form, or throws invalid_path {path, why}.
export function checkPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') refuse(String(raw ?? ''), 'empty');
  if (!raw.isWellFormed()) refuse(raw, 'not_utf8');
  if (CONTROL.test(raw)) refuse(raw, 'control_character');
  if (INVISIBLE.test(raw)) refuse(raw, 'invisible_character');
  if (raw.includes('\\')) refuse(raw, 'backslash');
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) refuse(raw, 'absolute');
  const path = raw.normalize('NFC');
  for (const seg of path.split('/')) {
    if (seg === '') refuse(raw, 'empty_segment');
    if (seg === '.' || seg === '..') refuse(raw, 'dot_segment');
    if (foldKey(seg) === '.git') refuse(raw, 'git_folder');
    if (Buffer.byteLength(seg, 'utf8') > MAX_SEGMENT_BYTES) refuse(raw, 'segment_too_long', { limit: MAX_SEGMENT_BYTES });
  }
  if (Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES) refuse(raw, 'too_long', { limit: MAX_PATH_BYTES });
  return path;
}

export function checkMode(path: string, mode: unknown): Mode {
  if (typeof mode === 'string' && (MODES as readonly string[]).includes(mode)) return mode as Mode;
  return refuse(path, 'bad_mode', { mode: String(mode) });
}

// Two paths that a case-insensitive file system (macOS APFS, Windows) would store as one file fold to the same key:
// "ſKILL.md" and "SKILL.md", "straße" and "STRASSE", "ﬁle" and "file", "aς" and "aσ". toLowerCase alone misses
// these, which would let a second file overwrite SKILL.md on disk with no risk flag.
export function foldKey(path: string): string {
  return path.normalize('NFKC').toUpperCase().toLowerCase().normalize('NFKC');
}

// A whole file list: each path, no duplicates (after NFC), no two equal ignoring case, no file that is also a folder
// of another, then the size limits. Returns the files sorted, with NFC paths.
export function checkTree(files: readonly { path: unknown; mode: unknown; bytes: Uint8Array }[], limits: Limits = DEFAULT_LIMITS): TreeFile[] {
  const out: TreeFile[] = [];
  const folded = new Map<string, string>();
  for (const f of files) {
    const path = checkPath(f.path);
    const mode = checkMode(path, f.mode);
    const key = foldKey(path);
    const clash = folded.get(key);
    if (clash !== undefined) refuse(path, clash === path ? 'duplicate' : 'case_clash', clash === path ? {} : { other: clash });
    folded.set(key, path);
    out.push({ path, mode, bytes: f.bytes });
  }
  for (const f of out) {
    const segs = foldKey(f.path).split('/');
    for (let i = 1; i < segs.length; i++) {
      const folder = segs.slice(0, i).join('/');
      if (folded.has(folder)) refuse(f.path, 'file_is_folder', { other: folded.get(folder) });
    }
  }
  if (out.length > limits.files) throw new CatalogError('too_large', { limit: 'files', max: limits.files, value: out.length });
  let total = 0;
  for (const f of out) {
    if (f.bytes.byteLength > limits.file_bytes) {
      throw new CatalogError('too_large', { limit: 'file_bytes', max: limits.file_bytes, value: f.bytes.byteLength, path: f.path });
    }
    total += f.bytes.byteLength;
  }
  if (total > limits.skill_bytes) throw new CatalogError('too_large', { limit: 'skill_bytes', max: limits.skill_bytes, value: total });
  return sortEntries(out);
}

const TEXT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Text = valid UTF-8 with no NUL byte. Binary files are never inlined in a read.
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    TEXT.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

export function decodeText(bytes: Uint8Array): string {
  return TEXT.decode(bytes);
}
