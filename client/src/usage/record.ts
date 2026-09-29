// Usage metrics (contract §3; the owner asked for them): seven events that say what an update hold costs the person and
// whether it changed an answer, and how the catalog is used. Each is one JSON line in $SKILLS_HOME/usage/<UTC day>.jsonl,
// kept 90 days and never sent anywhere.
//
// What's written is only each event's own fields, checked here (codes, counts, version numbers), so nothing a person or
// a publisher typed can ride along. A skill's name is stored as a keyed hash, with a key derived from this machine's
// confirm secret (confirm.key), so a copied log still counts per skill but names none. Recording never fails or slows
// what it records: like the activity log, a line that can't be written is dropped.
import { createHmac } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import { FLAG_KINDS, OPERATIONS, POLICIES } from '@skills-catalog/core';
import { confirmKey } from '../machine/publish-folder.ts';

export const USAGE_DAYS = 90;
/** A day file past this size isn't read (tens of thousands of events; a bigger one isn't ours to trust). */
export const USAGE_READ_MAX_BYTES = 8 * 1024 * 1024;
const FOLDER = 'usage';
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

type Policy = (typeof POLICIES)[number];
type FlagKind = (typeof FLAG_KINDS)[number];
/** Why an update or install was held (contract §3, §5.3): another catalog's skill, pinned, tell me first, flagged, or
 *  a new version still in its cooldown. */
export const HOLD_REASONS = ['other_catalog', 'pin', 'notify', 'flagged', 'cooldown'] as const;
export type HoldReason = (typeof HOLD_REASONS)[number];

/** The events as callers give them: a skill by its name, which is hashed before it's written. */
export type UsageEvent =
  | { event: 'hold'; skill: string; version: number; reason: HoldReason; flags: readonly FlagKind[]; behind: number }
  | { event: 'notice'; face: 'hook' | 'mcp'; waiting: number }
  | { event: 'look'; skill: string; version: number; face: 'cli' | 'assistant' | 'web' }
  | { event: 'answer'; skill: string; version: number; answer: 'yes' | 'no' | 'pin' | 'superseded'; together: number }
  | { event: 'policy'; from: Policy; to: Policy; scope: 'catalog' | 'skill'; near_hold: boolean }
  // At each sync, so it doubles as the count of syncs (a hook's sync is a session). The mode comes once the installer
  // detects permissive modes (contract §5.3); until then the event has only its face.
  | { event: 'mode'; mode?: 'default' | 'auto' | 'bypass' | 'sandbox_auto_allow' | 'broad_bash_rule'; face: 'hook' | 'mcp' | 'update' }
  // One per operation: the registry's name and a result code ("ok", an outcome such as a search's "none", or an error
  // code). Never the query, a name or a path.
  | { event: 'use'; op: string; result: string };

/** An event as stored and read back: when, and the skill as its hash. */
export type StoredEvent = UsageEvent & { v: 1; at: string };

// Each event's fields and what each may hold; anything else, or a value outside these, drops the event. A field marked
// optional may be left out.
type Check = ((v: unknown) => boolean) & { optional?: true };
const oneOf = (...xs: readonly string[]): Check => (v) => typeof v === 'string' && xs.includes(v);
const optional = (c: Check): Check => Object.assign((v: unknown) => c(v), { optional: true as const });
const count: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 0;
const version: Check = (v) => Number.isSafeInteger(v) && (v as number) >= 1;
const skill: Check = (v) => typeof v === 'string' && v.length > 0;
const kinds: Check = (v) => Array.isArray(v) && v.length <= FLAG_KINDS.length && v.every(oneOf(...FLAG_KINDS));
const code: Check = (v) => typeof v === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(v);
const FIELDS: Record<UsageEvent['event'], Record<string, Check>> = {
  hold: { skill, version, reason: oneOf(...HOLD_REASONS), flags: kinds, behind: count },
  notice: { face: oneOf('hook', 'mcp'), waiting: count },
  look: { skill, version, face: oneOf('cli', 'assistant', 'web') },
  answer: { skill, version, answer: oneOf('yes', 'no', 'pin', 'superseded'), together: (v) => count(v) && (v as number) >= 1 },
  policy: { from: oneOf(...POLICIES), to: oneOf(...POLICIES), scope: oneOf('catalog', 'skill'), near_hold: (v) => typeof v === 'boolean' },
  mode: { face: oneOf('hook', 'mcp', 'update'), mode: optional(oneOf('default', 'auto', 'bypass', 'sandbox_auto_allow', 'broad_bash_rule')) },
  use: { op: oneOf(...Object.keys(OPERATIONS)), result: code },
};

// The key for skill names: derived from the machine's confirm secret, for this use only. Only an event from an operation
// that writes anyway (a hold, an answer) may have the secret made; a read never creates or replaces it, and without a
// safe one an event naming a skill is dropped. Derived once per process and home, and used again only while the secret
// file is the same safe file.
const KEY_BYTES = 32;
const uid = process.getuid?.();
const safe = (st: Stats) => st.isFile() && st.nlink === 1 && (st.mode & 0o777) === 0o600 && st.uid === uid && st.size === KEY_BYTES;
const keys = new Map<string, { dev: number; ino: number; mtimeMs: number; key: Buffer }>();
const derive = (secret: Buffer) => createHmac('sha256', secret).update('skills-catalog usage metrics v1').digest();

// The secret as it is, never written: opened without following a link or waiting on a pipe, checked on the handle.
// (publish's own readConfirmKey replaces this once it's exported.)
function readSecret(path: string): Buffer | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const secret = Buffer.alloc(KEY_BYTES);
    return safe(fstatSync(fd)) && readSync(fd, secret, 0, KEY_BYTES, 0) === KEY_BYTES ? secret : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function usageKey(home: string, create: boolean): Buffer | null {
  const path = join(home, 'confirm.key');
  let st: Stats | undefined;
  try {
    st = lstatSync(path);
  } catch {
    // missing: made below only when allowed
  }
  const known = keys.get(home);
  if (st && safe(st) && known && known.dev === st.dev && known.ino === st.ino && known.mtimeMs === st.mtimeMs) return known.key;
  const secret = create ? confirmKey(home) : st && safe(st) ? readSecret(path) : null;
  if (!secret) return null;
  const now = lstatSync(path);
  const key = derive(secret);
  keys.set(home, { dev: now.dev, ino: now.ino, mtimeMs: now.mtimeMs, key });
  return key;
}
const hashed = (key: Buffer, name: string) => createHmac('sha256', key).update(name).digest('base64url').slice(0, 16);

/** A skill's name as this machine's usage events store it (for tests and tools; the secret must already be there). */
export function skillHash(home: string, name: string): string {
  const key = usageKey(home, false);
  if (!key) throw new Error('no usage key on this machine yet');
  return hashed(key, name);
}

/** The event with only its own fields, or null when it isn't one of the seven or a field isn't what it may hold. */
function checked(e: UsageEvent): Record<string, unknown> | null {
  const fields = Object.hasOwn(FIELDS, e?.event) ? FIELDS[e.event] : undefined;
  if (!fields) return null;
  const out: Record<string, unknown> = { event: e.event };
  for (const [k, ok] of Object.entries(fields)) {
    const v = Object.hasOwn(e, k) ? (e as Record<string, unknown>)[k] : undefined;
    if (v === undefined && ok.optional) continue;
    if (!ok(v)) return null;
    out[k] = v;
  }
  return out;
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const oldest = (now: Date) => dayOf(new Date(now.getTime() - USAGE_DAYS * DAY_MS));

// The usage folder, made 0700 if missing; null unless it's a plain folder of this user's. Checked and tightened through
// a handle opened without following a link, never by path.
function folder(home: string): string | null {
  const dir = join(home, FOLDER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isDirectory() || st.uid !== uid) return null;
    if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o700);
    return dir;
  } finally {
    closeSync(fd);
  }
}

// A day file this user owns, with no other name (a hard link would put the line somewhere else).
const ours = (st: Stats) => st.isFile() && st.nlink === 1 && st.uid === uid;

/** Records one event. Never throws: a line that can't be written is dropped. `createKey`: the event comes from an
 *  operation that writes anyway (a hold, an answer), so the machine secret may be made for it. */
export function recordUsage(home: string, e: UsageEvent, now: Date = new Date(), o: { createKey?: boolean } = {}): void {
  let dir: string | null = null;
  try {
    const fields = checked(e);
    if (!fields) return;
    dir = folder(home);
    if (!dir) return;
    if (typeof fields['skill'] === 'string') {
      const key = usageKey(home, o.createKey === true);
      if (!key) return;
      fields['skill'] = hashed(key, fields['skill']);
    }
    const line = JSON.stringify({ v: 1, at: now.toISOString(), ...fields }) + '\n';
    const fd = openSync(join(dir, `${dayOf(now)}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const st = fstatSync(fd);
      if (!ours(st)) return;
      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);
      writeSync(fd, Buffer.from(line)); // one write per line, with O_APPEND: two processes never tear a line
    } finally {
      closeSync(fd);
    }
  } catch {
    // dropped: what was being recorded matters, its count doesn't
  } finally {
    try {
      if (dir) prune(dir, now);
    } catch {
      // the next write tries again
    }
  }
}

// Whole days past the kept ones go; only the day files, never anything else in the folder.
function prune(dir: string, now: Date): void {
  const keepFrom = oldest(now);
  for (const name of readdirSync(dir)) {
    const m = DAY_FILE.exec(name);
    if (m && m[1]! < keepFrom && lstatSync(join(dir, name)).isFile()) unlinkSync(join(dir, name));
  }
}

/** The kept events, oldest first; lines that can't be read are skipped. */
export const readUsage = (home: string, now: Date = new Date()): StoredEvent[] => readFrom(home, oldest(now));

/** Whether a hold was recorded in the 24 hours before `now` (a policy change's near_hold). */
export function holdWithinADay(home: string, now: Date = new Date()): boolean {
  const since = now.getTime() - DAY_MS;
  return readFrom(home, dayOf(new Date(since))).some((e) => e.event === 'hold' && Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime());
}

// The events in the day files from `fromDay` on, oldest first.
function readFrom(home: string, fromDay: string): StoredEvent[] {
  const dir = join(home, FOLDER);
  let names: string[];
  try {
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const events: StoredEvent[] = [];
  for (const name of names.sort()) {
    const m = DAY_FILE.exec(name);
    if (!m || m[1]! < fromDay) continue;
    const text = readDayFile(join(dir, name));
    if (text === null) continue;
    for (const line of text.split('\n')) {
      const e = parsed(line);
      if (e) events.push(e);
    }
  }
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

// A day file's text, only from a plain file of a sane size: opened without following a link or waiting on a pipe, and
// checked on the handle that's read. Null otherwise.
function readDayFile(path: string): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!ours(st) || st.size > USAGE_READ_MAX_BYTES) return null;
    const bytes = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, bytes, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return bytes.subarray(0, read).toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// One stored line, when it's a version-1 event with its own fields (the skill as stored, a hash).
function parsed(line: string): StoredEvent | null {
  let o: unknown;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  if (r['v'] !== 1 || typeof r['at'] !== 'string' || Number.isNaN(Date.parse(r['at']))) return null;
  // A line kept from before the field was renamed says surface where a new one says face.
  if (!Object.hasOwn(r, 'face') && Object.hasOwn(r, 'surface')) r['face'] = r['surface'];
  const fields = checked(r as UsageEvent);
  return fields ? ({ v: 1, at: r['at'], ...fields } as StoredEvent) : null;
}
