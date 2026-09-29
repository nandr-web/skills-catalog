// Usage metrics (contract §3; the owner asked for them): seven events that say what an update hold costs the person and
// whether it changed an answer, and how the catalog is used. Each is one JSON line in $SKILLS_HOME/usage/<UTC day>.jsonl,
// kept 90 days and never sent anywhere.
//
// What's written is only each event's own fields, checked here (codes, counts, version numbers), so nothing a person or
// a publisher typed can ride along. A skill's name is stored as a keyed hash, with a key derived from this machine's
// confirm secret (confirm.key), so a copied log still counts per skill but names none. Recording never fails or slows
// what it records: like the activity log, a line that can't be written is dropped.
import { createHmac } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { FLAG_KINDS, OPERATIONS, POLICIES } from '@skills-catalog/core';
import { confirmKey } from '../machine/publish-folder.ts';

export const USAGE_DAYS = 90;
const FOLDER = 'usage';
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 86_400_000;

type Policy = (typeof POLICIES)[number];
type FlagKind = (typeof FLAG_KINDS)[number];

/** The events as callers give them: a skill by its name, which is hashed before it's written. */
export type UsageEvent =
  | { event: 'hold'; skill: string; version: number; reason: 'flagged' | 'notify' | 'pin' | 'cooldown'; flags: readonly FlagKind[]; behind: number }
  | { event: 'notice'; surface: 'hook' | 'mcp'; waiting: number }
  | { event: 'look'; skill: string; version: number; surface: 'cli' | 'assistant' | 'web' }
  | { event: 'answer'; skill: string; version: number; answer: 'yes' | 'no' | 'pin' | 'superseded'; together: number }
  | { event: 'policy'; from: Policy; to: Policy; scope: 'catalog' | 'skill'; near_hold: boolean }
  // At each sync, so it doubles as the count of syncs (a hook's sync is a session). The mode comes once the installer
  // detects permissive modes (contract §5.3); until then the event has only its surface.
  | { event: 'mode'; mode?: 'default' | 'auto' | 'bypass' | 'sandbox_auto_allow' | 'broad_bash_rule'; surface: 'hook' | 'mcp' | 'update' }
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
  hold: { skill, version, reason: oneOf('flagged', 'notify', 'pin', 'cooldown'), flags: kinds, behind: count },
  notice: { surface: oneOf('hook', 'mcp'), waiting: count },
  look: { skill, version, surface: oneOf('cli', 'assistant', 'web') },
  answer: { skill, version, answer: oneOf('yes', 'no', 'pin', 'superseded'), together: (v) => count(v) && (v as number) >= 1 },
  policy: { from: oneOf(...POLICIES), to: oneOf(...POLICIES), scope: oneOf('catalog', 'skill'), near_hold: (v) => typeof v === 'boolean' },
  mode: { surface: oneOf('hook', 'mcp', 'update'), mode: optional(oneOf('default', 'auto', 'bypass', 'sandbox_auto_allow', 'broad_bash_rule')) },
  use: { op: oneOf(...Object.keys(OPERATIONS)), result: code },
};

// The key for skill names: derived from the machine's confirm secret, for this use only.
const usageKey = (home: string) => createHmac('sha256', confirmKey(home)).update('skills-catalog usage metrics v1').digest();
const hashed = (key: Buffer, name: string) => createHmac('sha256', key).update(name).digest('base64url').slice(0, 16);

/** A skill's name as this machine's usage events store it. */
export const skillHash = (home: string, name: string) => hashed(usageKey(home), name);

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

// The usage folder, made 0700 if missing; null when something other than a plain folder is in its place.
function folder(home: string): string | null {
  const dir = join(home, FOLDER);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  return st.isDirectory() && !st.isSymbolicLink() ? dir : null;
}

/** Records one event. Never throws: a line that can't be written is dropped. */
export function recordUsage(home: string, e: UsageEvent, now: Date = new Date()): void {
  try {
    const fields = checked(e);
    if (!fields) return;
    const dir = folder(home);
    if (!dir) return;
    if (typeof fields['skill'] === 'string') fields['skill'] = hashed(usageKey(home), fields['skill']);
    const line = JSON.stringify({ v: 1, at: now.toISOString(), ...fields }) + '\n';
    const fd = openSync(join(dir, `${dayOf(now)}.jsonl`), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      if (!fstatSync(fd).isFile()) return;
      writeSync(fd, Buffer.from(line)); // one write per line, with O_APPEND: two processes never tear a line
    } finally {
      closeSync(fd);
    }
    prune(dir, now);
  } catch {
    // dropped: what was being recorded matters, its count doesn't
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
    let text: string;
    try {
      text = readFileSync(join(dir, name), { encoding: 'utf8', flag: constants.O_RDONLY | constants.O_NOFOLLOW });
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const e = parsed(line);
      if (e) events.push(e);
    }
  }
  return events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
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
  const fields = checked(r as UsageEvent);
  return fields ? ({ v: 1, at: r['at'], ...fields } as StoredEvent) : null;
}
