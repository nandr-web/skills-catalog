// Teardown (setup build notes §5; contract §6 "teardown removes them"; skill-setup-welcome's "teardown undoes everything
// setup wrote"): it removes only what setup's record says setup added, from the places it rebuilds from its own settings
// (.claude.json, .claude/settings.json, the terminal's launcher), never a path the record names elsewhere. Per entry:
// still exactly as recorded, removed (the span it was inserted as, and a container setup made once it's empty); changed
// since, left and named; gone, named. A file setup created from nothing and nobody changed is deleted whole. Each file is
// backed up before it changes and written as setup writes (checked again right before the place, up to 3 tries). A
// record that can't be used proves nothing: nothing is removed, and entries that look like setup's are named for the
// person to remove by hand. It never reads lock.json or config.json except to name them when damaged, and it keeps the
// catalog, installed skills, config.json and the backups.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError } from '@skills-catalog/core';
import { jsonEqual } from './json-equal.ts';
import { readJsonFile, type Snapshot } from './json-file.ts';
import { removeItem, removeMember } from './json-splice.ts';
import { scanJson, type JsonContainer, type JsonNode } from './json-text.ts';
import { folderId, writeFileText } from './json-write.ts';
import { withLockFile } from './lock.ts';
import { isPrivate } from './private.ts';
import { CLAUDE_JSON_CAP, SETTINGS_CAP } from './setup-plan.ts';
import { checkPlaces, RECORD_CAP, type SetupPlaces } from './setup-places.ts';
import type { RecordEntry, SetupRecord } from './setup-record.ts';
import { SERVER_NAME } from './setup-merge.ts';

export type TeardownInput = {
  assistantHome: string;
  skillsHome: string;
  env: Readonly<Record<string, string | undefined>>;
  uid: number;
  now: () => number;
};
/** What a line of the summary says about one thing setup added. */
export type What = { kind: 'mcp' | 'hook' | 'rule' | 'file' | 'command'; rule?: string };
export type TeardownLine =
  | { state: 'removed' | 'changed' | 'gone'; path: string; what: What }
  | { state: 'unusable'; path: string; why: string }
  | { state: 'not_here'; path: string }
  | { state: 'damaged'; path: string };
export type TeardownResult = {
  places: SetupPlaces;
  /** The record couldn't be used: nothing was removed; `found` are entries that look like setup's. */
  recordUnusable?: { found: { path: string; what: What }[] };
  lines: TeardownLine[];
  backups: string[];
};

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const part = (n: bigint) => (n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n.toString());
const TRIES = 3;
const lstatOr = (path: string): BigIntStats | undefined => {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    return undefined;
  }
};
const everything = () => true;
const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const whatOf = (e: RecordEntry): What => (e.kind === 'mcp_entry' ? { kind: 'mcp' } : e.kind === 'hook_group' ? { kind: 'hook' } : { kind: 'rule', rule: e.value as string });

// ---------- removing one entry from a file's text ----------

const memberNode = (c: JsonNode | undefined, key: string): JsonNode | undefined => (c && c.kind === 'object' ? c.members.find((m) => m.key === key)?.value : undefined);
const valueOf = (text: string, n: JsonNode) => JSON.parse(text.slice(n.start, n.end)) as unknown;
const childrenOf = (c: JsonContainer) => (c.kind === 'object' ? c.members.map((m) => m.value) : c.items);

/** The text without one empty container setup made: `path` like ['hooks', 'SessionStart']. */
function dropIfEmpty(text: string, path: readonly string[]): string {
  const root = scanJson(text, everything);
  let parent: JsonNode | undefined = root;
  for (const k of path.slice(0, -1)) parent = memberNode(parent, k);
  const node = memberNode(parent, path.at(-1)!);
  if (!parent || parent.kind !== 'object' || !node || (node.kind !== 'object' && node.kind !== 'array') || childrenOf(node).length) return text;
  return removeMember(text, parent, path.at(-1)!);
}

/** One entry taken out of the text, when it's there exactly as recorded: the new text, or 'changed' / 'gone'. */
function removeEntry(text: string, e: RecordEntry): string | 'changed' | 'gone' {
  const root = scanJson(text, everything);
  const created = e.created ?? [];
  if (e.kind === 'mcp_entry') {
    const servers = memberNode(root, 'mcpServers');
    const node = memberNode(servers, SERVER_NAME);
    if (!node) return 'gone';
    if (!jsonEqual(valueOf(text, node), e.value)) return 'changed';
    let t = removeMember(text, servers as JsonContainer, SERVER_NAME);
    if (created.includes('mcpServers')) t = dropIfEmpty(t, ['mcpServers']);
    return t;
  }
  const [outer, inner] = e.kind === 'hook_group' ? ['hooks', 'SessionStart'] : ['permissions', 'allow'];
  const list = memberNode(memberNode(root, outer!), inner!);
  if (!list || list.kind !== 'array') return 'gone';
  const items = list.items.map((n) => valueOf(text, n));
  // A rule: its last occurrence (setup appends); a hook group: the one equal to the record.
  const index = e.kind === 'hook_group' ? items.findIndex((v) => jsonEqual(v, e.value)) : items.lastIndexOf(e.value as string);
  if (index < 0) return e.kind === 'hook_group' && items.some((v) => isObject(v) && JSON.stringify(v).includes('hook session-start')) ? 'changed' : 'gone';
  let t = removeItem(text, list, index);
  if (created.includes(`${outer}.${inner}` as never)) t = dropIfEmpty(t, [outer!, inner!]);
  if (created.includes(outer as never)) t = dropIfEmpty(t, [outer!]);
  return t;
}

// ---------- files ----------

/** A new file of teardown's own (a backup), made only where nothing stands, 0600, synced; its identity. */
function writeNew(path: string, bytes: Buffer): BigIntStats {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    for (let at = 0; at < bytes.length; ) at += writeSync(fd, bytes, at);
    fsyncSync(fd);
    return fstatSync(fd, { bigint: true });
  } finally {
    closeSync(fd);
  }
}

function backupsFolder(path: string): void {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const s = lstatOr(path);
  if (!s || s.isSymbolicLink()) throw new CatalogError('target_symlink', { path });
  if (!s.isDirectory() || !isPrivate(s)) throw new CatalogError('target_not_private', { path, own: s.uid === BigInt(process.getuid?.() ?? -1) });
}

/** A file of setup's own deleted only while it's the one recorded: this user's regular file, one link, these bytes. */
function deleteIfSame(path: string, hash: string): 'removed' | 'changed' | 'gone' {
  const s = lstatOr(path);
  if (!s) return 'gone';
  if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(process.getuid?.() ?? -1)) return 'changed';
  if (sha256(readFileSync(path)) !== hash) return 'changed';
  unlinkSync(path);
  return 'removed';
}

export async function runTeardown(input: TeardownInput): Promise<TeardownResult> {
  const first = checkPlaces({ assistantHome: input.assistantHome, skillsHome: input.skillsHome, env: input.env, uid: input.uid, lenient: true });
  const { places } = first;
  // Never through a damaged record: nothing can be proven setup's, so only name what looks like it.
  if (first.recordUnusable !== undefined || (!first.record && !first.missing.skillsHome && lstatOr(places.record))) return { places, recordUnusable: { found: lookAlikes(places) }, lines: damaged(places), backups: [] };
  if (!first.record) {
    const found = lookAlikes(places);
    return { places, ...(found.length ? { recordUnusable: { found } } : {}), lines: damaged(places), backups: [] };
  }
  return withLockFile(places.lock, input.now, () => underLock(input));
}

/** lock.json and config.json named when damaged (teardown never needs them, and never stops for them). */
function damaged(places: SetupPlaces): TeardownLine[] {
  return ['lock.json', 'config.json'].flatMap((f) => {
    const path = join(places.skillsHome, f);
    const r = readJsonFile(path, SETTINGS_CAP, { forWrite: false });
    return 'why' in r ? [{ state: 'damaged' as const, path }] : [];
  });
}

/** Entries by name that look like setup's, for the person to remove by hand when the record can't be used. */
function lookAlikes(places: SetupPlaces): { path: string; what: What }[] {
  const out: { path: string; what: What }[] = [];
  const c = readJsonFile(places.claudeJson, CLAUDE_JSON_CAP, { forWrite: false });
  if ('value' in c && isObject(c.value['mcpServers']) && Object.hasOwn(c.value['mcpServers'], SERVER_NAME)) out.push({ path: places.claudeJson, what: { kind: 'mcp' } });
  const s = readJsonFile(places.settingsJson, SETTINGS_CAP, { forWrite: false });
  if ('value' in s && JSON.stringify(s.value['hooks'] ?? {}).includes('hook session-start')) out.push({ path: places.settingsJson, what: { kind: 'hook' } });
  if (lstatOr(places.command)) out.push({ path: places.command, what: { kind: 'command' } });
  return out;
}

function underLock(input: TeardownInput): TeardownResult {
  const checked = checkPlaces({ assistantHome: input.assistantHome, skillsHome: input.skillsHome, env: input.env, uid: input.uid, lenient: true });
  const { places } = checked;
  if (checked.recordUnusable !== undefined || !checked.record) return { places, recordUnusable: { found: lookAlikes(places) }, lines: damaged(places), backups: [] };
  const record: SetupRecord = structuredClone(checked.record);
  const away = new Set(checked.elsewhere ?? []);
  const lines: TeardownLine[] = [...away].map((path) => ({ state: 'not_here' as const, path }));
  const backups: string[] = [];
  const utc = new Date(input.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const left: RecordEntry[] = [];
  const createdLeft: SetupRecord['created_files'] = [];

  const saveRecord = () => {
    const f = readJsonFile(places.record, RECORD_CAP, { forWrite: true });
    const was: Snapshot | 'absent' = 'snapshot' in f ? f.snapshot : 'absent';
    if (writeFileText(places.record, `${JSON.stringify(record, null, 2)}\n`, was, folderId(places.skillsHome)) !== 'written') throw new CatalogError('target_changed', { path: places.record });
  };

  for (const path of [places.claudeJson, places.settingsJson]) {
    const entries = record.entries.filter((e) => e.file === path && !away.has(e.file));
    const created = record.created_files.find((c) => c.file === path);
    if (!entries.length && !created) continue;
    for (let attempt = 1; ; attempt++) {
      const f = readJsonFile(path, path === places.claudeJson ? CLAUDE_JSON_CAP : SETTINGS_CAP, { forWrite: true });
      if ('absent' in f) {
        for (const e of entries) lines.push({ state: 'gone', path, what: whatOf(e) });
        break;
      }
      if ('why' in f) {
        lines.push({ state: 'unusable', path, why: f.why });
        left.push(...entries);
        if (created) createdLeft.push(created);
        break;
      }
      // A file setup made from nothing that nobody changed goes whole, giving back the folder as it was.
      if (created && sha256(f.text) === created.sha256) {
        if (deleteIfSame(path, created.sha256) === 'removed') {
          lines.push({ state: 'removed', path, what: { kind: 'file' } });
          break;
        }
      }
      let text = f.text;
      const said: TeardownLine[] = [];
      const kept: RecordEntry[] = [];
      // Last added first, so each removal finds the text around it as it was.
      for (const e of [...entries].reverse()) {
        if (e.kind === 'allow_rule' && e.was_there) continue;   // the person's before setup: never touched
        const r = removeEntry(text, e);
        if (r === 'changed' || r === 'gone') {
          said.unshift({ state: r, path, what: whatOf(e) });
          if (r === 'changed') kept.unshift(e);
        } else {
          text = r;
          said.unshift({ state: 'removed', path, what: whatOf(e) });
        }
      }
      if (text === f.text) {
        lines.push(...said);
        left.push(...kept);
        break;
      }
      backupsFolder(places.backups);
      const copy = join(places.backups, `${utc}-${randomBytes(2).toString('hex')}-${path === places.claudeJson ? 'claude.json' : 'settings.json'}`);
      const id = writeNew(copy, Buffer.from(f.text, 'utf8'));
      record.backups.push({ file: path, path: copy, sha256: sha256(f.text), dev: part(id.dev), ino: part(id.ino), birth: part(id.birthtimeMs) });
      saveRecord();
      if (writeFileText(path, text, f.snapshot, folderId(dirname(path))) === 'written') {
        backups.push(copy);
        lines.push(...said);
        left.push(...kept);
        break;
      }
      if (attempt === TRIES) throw new CatalogError('assistant_file_changed', { path });
    }
  }

  // The terminal's launcher: deleted only while it's still the file setup made.
  const launcher = record.created_files.find((c) => c.file === places.command);
  if (launcher) {
    const r = deleteIfSame(places.command, launcher.sha256);
    lines.push({ state: r, path: places.command, what: { kind: 'command' } });
    if (r === 'changed') createdLeft.push(launcher);
  }

  // Two backups of each file kept, as setup keeps them.
  for (const file of [places.claudeJson, places.settingsJson]) {
    const mine = record.backups.filter((b) => b.file === file);
    for (const old of mine.slice(0, -2)) {
      if (deleteIfSame(old.path, old.sha256) !== 'changed') record.backups = record.backups.filter((b) => b !== old);
    }
  }
  record.entries = left;
  record.created_files = createdLeft;
  // The record stays while anything is left for a later teardown to name, or a backup it lists is kept.
  if (left.length || createdLeft.length || record.backups.length) saveRecord();
  else deleteIfSame(places.record, sha256(readFileSync(places.record)));
  lines.push(...damaged(places));
  return { places, lines, backups };
}
