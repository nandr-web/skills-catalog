// Setup's own entries merged into each assistant file's text (setup build notes §2, byte pins 1-6), pure: the text in, the
// text to write (or none) and the record's entries out. Only setup's spans change: a value is added last in its
// container, replaced where it is, or left; a missing container is made last in its parent (hooks before permissions).
// An entry is setup's only when it deep-equals what the record says setup wrote. After every splice, the file without
// setup's entries must equal the file before, or it's internal_error: a bug here, never the person's file.

import { jsonEqual } from './json-equal.ts';
import { appendItem, freshText, insertMember, replaceValue } from './json-splice.ts';
import { JsonTextError, scanJson, type JsonContainer, type JsonNode } from './json-text.ts';
import type { Container, EntryKind, RecordEntry } from './setup-record.ts';

export const SERVER_NAME = 'skills-catalog';

/** An entry as the record will list it (its file and state are the planner's). */
export type PlannedEntry = { kind: EntryKind; value: unknown; was_there?: boolean; created?: Container[] };
export type MergeRefusal =
  | { code: 'name_taken'; name: typeof SERVER_NAME }
  | { code: 'assistant_file_unusable'; why: 'duplicate_key' | 'wrong_type'; key: string }
  | { code: 'internal_error' };
/** `text` undefined: the file already holds exactly this run's entries, so nothing is written. */
export type Merged = { refusal: MergeRefusal } | { text: string | undefined; entries: PlannedEntry[] };

/** What setup changed in a file, for the check: the MCP entry, the hook group at its index, the rules appended last,
 *  and the containers it made. */
export type Marks = { mcp?: 'inserted' | 'replaced'; hook?: { index: number; replaced: boolean }; rulesAppended?: number; created: Container[] };

type Obj = Record<string, unknown>;
const isObject = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const own = (o: Obj, k: string) => (Object.hasOwn(o, k) ? o[k] : undefined);

// Setup's path in each file: the keys that may appear only once there, and the types its containers must have.
const CLAUDE_ONCE = { '': ['mcpServers'], mcpServers: [SERVER_NAME] };
const SETTINGS_ONCE = { '': ['hooks', 'permissions'], hooks: ['SessionStart'], permissions: ['allow'] };

/** The file's value and the places of the members on setup's path, or why it can't be used. */
function scan(text: string, once: Record<string, readonly string[]>): { root: JsonContainer; value: Obj } | { refusal: MergeRefusal } {
  let root: JsonNode;
  try {
    // The top, each container setup's keys sit in, and each of setup's containers in them (so a list's items are kept).
    const onPath = (p: readonly string[]) => p.length === 0 || (Object.hasOwn(once, p[0]!) && (p.length === 1 || (p.length === 2 && once[p[0]!]!.includes(p[1]!))));
    root = scanJson(text, onPath, once);
  } catch (e) {
    // The reader passed this text; only a key twice is left to find here.
    if (e instanceof JsonTextError && e.why === 'duplicate_key') return { refusal: { code: 'assistant_file_unusable', why: 'duplicate_key', key: e.key! } };
    throw e;
  }
  return { root: root as JsonContainer, value: JSON.parse(text) as Obj };
}

const wrongType = (key: string): { refusal: MergeRefusal } => ({ refusal: { code: 'assistant_file_unusable', why: 'wrong_type', key } });
const member = (c: JsonContainer, key: string): JsonNode | undefined => (c.kind === 'object' ? c.members.find((m) => m.key === key)?.value : undefined);
const container = (c: JsonContainer, key: string) => member(c, key) as JsonContainer;
const union = (...lists: (readonly Container[] | undefined)[]): Container[] | undefined => {
  const all = [...new Set(lists.flatMap((l) => l ?? []))];
  return all.length ? all : undefined;
};
const withCreated = (e: PlannedEntry, created: Container[] | undefined): PlannedEntry => (created ? { ...e, created } : e);

/** The file's value without setup's entries: from the text after (`after`) everything setup added, made or replaced;
 *  from the text before, only what setup replaced. */
function withoutSetup(value: Obj, m: Marks, after: boolean): Obj {
  const v = structuredClone(value);
  const servers = own(v, 'mcpServers');
  if (m.mcp && (after || m.mcp === 'replaced') && isObject(servers)) delete servers[SERVER_NAME];
  const hooks = own(v, 'hooks');
  const groups = isObject(hooks) ? own(hooks, 'SessionStart') : undefined;
  if (m.hook && (after || m.hook.replaced) && Array.isArray(groups)) groups.splice(m.hook.index, 1);
  const permissions = own(v, 'permissions');
  const allow = isObject(permissions) ? own(permissions, 'allow') : undefined;
  if (after && m.rulesAppended && Array.isArray(allow)) allow.splice(allow.length - m.rulesAppended, m.rulesAppended);
  if (after) {
    // Innermost first, so a made parent is taken out with its made child already gone.
    if (m.created.includes('hooks.SessionStart') && isObject(hooks)) delete hooks['SessionStart'];
    if (m.created.includes('permissions.allow') && isObject(permissions)) delete permissions['allow'];
    for (const c of ['mcpServers', 'hooks', 'permissions'] as const) if (m.created.includes(c)) delete v[c];
  }
  return v;
}

/** Whether `after` is `before` (an absent file is `{}`) with only setup's entries added, replaced or made. */
export function keptApartFromSetup(before: string | undefined, after: string, m: Marks): boolean {
  try {
    const b = before === undefined ? {} : (JSON.parse(before) as Obj);
    const a = JSON.parse(after) as unknown;
    return isObject(a) && jsonEqual(withoutSetup(b, m, false), withoutSetup(a, m, true));
  } catch {
    return false;
  }
}

const checked = (before: string | undefined, text: string, m: Marks, entries: PlannedEntry[]): Merged =>
  keptApartFromSetup(before, text, m) ? { text, entries } : { refusal: { code: 'internal_error' } };

/** `.claude.json`: `mcpServers["skills-catalog"]` only. `recorded` is the record's entries in this file. */
export function mergeClaudeJson(before: string | undefined, entry: Obj, recorded: readonly RecordEntry[]): Merged {
  const ours = recorded.find((e) => e.kind === 'mcp_entry');
  const planned = (created?: Container[]) => [withCreated({ kind: 'mcp_entry', value: entry }, union(ours?.created, created))];
  if (before === undefined) return checked(before, freshText({ mcpServers: { [SERVER_NAME]: entry } }), { mcp: 'inserted', created: ['mcpServers'] }, planned(['mcpServers']));

  const s = scan(before, CLAUDE_ONCE);
  if ('refusal' in s) return s;
  const servers = own(s.value, 'mcpServers');
  if (servers !== undefined && !isObject(servers)) return wrongType('mcpServers');
  const current = isObject(servers) ? own(servers, SERVER_NAME) : undefined;
  if (current !== undefined && !isObject(current)) return wrongType(`mcpServers.${SERVER_NAME}`);

  if (servers === undefined) return checked(before, insertMember(before, s.root, 'mcpServers', { [SERVER_NAME]: entry }).text, { mcp: 'inserted', created: ['mcpServers'] }, planned(['mcpServers']));
  const box = container(s.root, 'mcpServers');
  if (current === undefined) return checked(before, insertMember(before, box, SERVER_NAME, entry).text, { mcp: 'inserted', created: [] }, planned());
  if (jsonEqual(current, entry)) return { text: undefined, entries: planned() };
  if (ours && jsonEqual(current, ours.value)) return checked(before, replaceValue(before, member(box, SERVER_NAME)!, entry, box), { mcp: 'replaced', created: [] }, planned());
  return { refusal: { code: 'name_taken', name: SERVER_NAME } };
}

/** `.claude/settings.json`: one group in `hooks.SessionStart` and the allow rules in `permissions.allow`. */
export function mergeSettingsJson(before: string | undefined, want: { hook: Obj; rules: readonly string[] }, recorded: readonly RecordEntry[]): Merged {
  const ourHook = recorded.find((e) => e.kind === 'hook_group');
  const ourRules = recorded.filter((e) => e.kind === 'allow_rule' && e.was_there === false);
  const rulesCreated = union(...ourRules.map((e) => e.created));
  const hookEntry = (created?: Container[]) => withCreated({ kind: 'hook_group', value: want.hook }, union(ourHook?.created, created));
  // The rules in this run's order, then setup's earlier rules this run doesn't want, while they're still in the file;
  // the containers setup made for them go on the first rule that's setup's.
  const ruleEntries = (inFile: readonly unknown[], appended: readonly string[], created?: Container[]): PlannedEntry[] => {
    const wanted = want.rules.map((r): PlannedEntry => ({ kind: 'allow_rule', value: r, was_there: !appended.includes(r) && !ourRules.some((e) => e.value === r) }));
    const kept = ourRules.filter((e) => !want.rules.includes(e.value as string) && inFile.includes(e.value)).map((e): PlannedEntry => ({ kind: 'allow_rule', value: e.value, was_there: false }));
    const all = [...wanted, ...kept];
    const first = all.findIndex((e) => !e.was_there);
    const made = union(rulesCreated, created);
    if (first >= 0 && made) all[first] = withCreated(all[first]!, made);
    return all;
  };

  if (before === undefined) {
    const text = freshText({ hooks: { SessionStart: [want.hook] }, permissions: { allow: want.rules } });
    const created: Container[] = ['hooks', 'hooks.SessionStart', 'permissions', 'permissions.allow'];
    return checked(before, text, { hook: { index: 0, replaced: false }, rulesAppended: want.rules.length, created }, [hookEntry(['hooks', 'hooks.SessionStart']), ...ruleEntries([], want.rules, ['permissions', 'permissions.allow'])]);
  }

  let s = scan(before, SETTINGS_ONCE);
  if ('refusal' in s) return s;
  const hooks = own(s.value, 'hooks');
  if (hooks !== undefined && !isObject(hooks)) return wrongType('hooks');
  const groups = isObject(hooks) ? own(hooks, 'SessionStart') : undefined;
  if (groups !== undefined && !Array.isArray(groups)) return wrongType('hooks.SessionStart');
  const permissions = own(s.value, 'permissions');
  if (permissions !== undefined && !isObject(permissions)) return wrongType('permissions');
  const allow = isObject(permissions) ? own(permissions, 'allow') : undefined;
  if (allow !== undefined && !Array.isArray(allow)) return wrongType('permissions.allow');

  // The hook group: there → nothing; setup's recorded one → replaced in place; else appended, making what's missing.
  let text = before;
  const marks: Marks = { created: [] };
  let hookMade: Container[] | undefined;
  if (groups === undefined) {
    hookMade = hooks === undefined ? ['hooks', 'hooks.SessionStart'] : ['hooks.SessionStart'];
    text = hooks === undefined ? insertMember(text, s.root, 'hooks', { SessionStart: [want.hook] }).text : insertMember(text, container(s.root, 'hooks'), 'SessionStart', [want.hook]).text;
    marks.hook = { index: 0, replaced: false };
    marks.created.push(...hookMade);
  } else if (!groups.some((g) => jsonEqual(g, want.hook))) {
    const box = container(container(s.root, 'hooks'), 'SessionStart');
    const at = ourHook ? groups.findIndex((g) => jsonEqual(g, ourHook.value)) : -1;
    if (at >= 0 && box.kind === 'array') text = replaceValue(text, box.items[at]!, want.hook, box);
    else text = appendItem(text, box, want.hook).text;
    marks.hook = { index: at >= 0 ? at : groups.length, replaced: at >= 0 };
  }

  // The allow rules: each one missing appended, making what's missing.
  const inFile = Array.isArray(allow) ? allow : [];
  const missing = want.rules.filter((r) => !inFile.includes(r));
  let rulesMade: Container[] | undefined;
  if (missing.length) {
    if (text !== before) {
      const again = scan(text, SETTINGS_ONCE);
      if ('refusal' in again) return { refusal: { code: 'internal_error' } };
      s = again;
    }
    if (permissions === undefined) {
      rulesMade = ['permissions', 'permissions.allow'];
      text = insertMember(text, s.root, 'permissions', { allow: missing }).text;
    } else if (allow === undefined) {
      rulesMade = ['permissions.allow'];
      text = insertMember(text, container(s.root, 'permissions'), 'allow', missing).text;
    } else {
      for (const r of missing) {
        const now = scan(text, SETTINGS_ONCE);
        if ('refusal' in now) return { refusal: { code: 'internal_error' } };
        text = appendItem(text, container(container(now.root, 'permissions'), 'allow'), r).text;
      }
    }
    marks.rulesAppended = missing.length;
    marks.created.push(...(rulesMade ?? []));
  }

  const entries = [hookEntry(hookMade), ...ruleEntries(inFile, missing, rulesMade)];
  return text === before ? { text: undefined, entries } : checked(before, text, marks, entries);
}
