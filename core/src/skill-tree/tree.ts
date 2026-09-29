// A skill's files as bytes, and the rules every file list obeys (contract §4.2, §4.3). Shared by the catalog core and
// the installer, so a tree is checked and fingerprinted the same way on both sides.

import { createHash } from 'node:crypto';
import { CatalogError } from '../errors.ts';

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

// One path: returns its NFC form, or throws invalid_path {path, why}.
export function checkPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw === '') throw new CatalogError('invalid_path', { path: String(raw ?? ''), why: 'empty' });
  if (!raw.isWellFormed()) throw new CatalogError('invalid_path', { path: raw, why: 'not valid UTF-8' });
  if (CONTROL.test(raw)) throw new CatalogError('invalid_path', { path: raw, why: 'control character' });
  if (raw.includes('\\')) throw new CatalogError('invalid_path', { path: raw, why: 'backslash; use /' });
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new CatalogError('invalid_path', { path: raw, why: 'absolute' });
  const path = raw.normalize('NFC');
  for (const seg of path.split('/')) {
    if (seg === '') throw new CatalogError('invalid_path', { path: raw, why: 'empty segment' });
    if (seg === '.' || seg === '..') throw new CatalogError('invalid_path', { path: raw, why: `"${seg}" segment` });
  }
  if (Buffer.byteLength(path, 'utf8') > 1024) throw new CatalogError('invalid_path', { path: raw, why: 'longer than 1024 bytes' });
  return path;
}

export function checkMode(path: string, mode: unknown): Mode {
  if (typeof mode === 'string' && (MODES as readonly string[]).includes(mode)) return mode as Mode;
  throw new CatalogError('invalid_path', { path, why: `mode ${String(mode)}; only 0644 or 0755` });
}

// A whole file list: each path, no duplicates (after NFC), no two equal ignoring case, no file that is also a folder
// of another, then the size limits. Returns the files sorted, with NFC paths.
export function checkTree(files: readonly { path: unknown; mode: unknown; bytes: Uint8Array }[], limits: Limits = DEFAULT_LIMITS): TreeFile[] {
  const out: TreeFile[] = [];
  const folded = new Map<string, string>();
  for (const f of files) {
    const path = checkPath(f.path);
    const mode = checkMode(path, f.mode);
    const key = path.toLowerCase();
    const clash = folded.get(key);
    if (clash !== undefined) {
      throw new CatalogError('invalid_path', { path, why: clash === path ? 'duplicate path' : `same as ${clash} ignoring case` });
    }
    folded.set(key, path);
    out.push({ path, mode, bytes: f.bytes });
  }
  for (const f of out) {
    const segs = f.path.toLowerCase().split('/');
    for (let i = 1; i < segs.length; i++) {
      const folder = segs.slice(0, i).join('/');
      if (folded.has(folder)) throw new CatalogError('invalid_path', { path: f.path, why: `${folded.get(folder)} is a file, not a folder` });
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
