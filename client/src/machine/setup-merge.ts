// Setup's own entries merged into each assistant file's text (setup build notes §2, byte pins 1-6), pure: the text in, the
// text to write (or none) and the record's entries out. Only setup's spans change: a value is added last in its
// container, replaced where it is, or left; a missing container is made last in its parent (hooks before permissions).
// An entry is setup's only when it deep-equals what the record says setup wrote. After every splice, the file without
// setup's entries must equal the file before, or it's internal_error: a bug here, never the person's file.

import { jsonEqual } from './json-equal.ts';
import { appendItem, freshText, insertMember, replaceValue, type Spliced } from './json-splice.ts';
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
 *  the containers it made, and the values this run put there. */
export type Marks = {
  mcp?: 'inserted' | 'replaced';
  hook?: { index: number; replaced: boolean };
  rulesAppended?: number;
  created: Container[];
  values?: { mcp?: unknown; hook?: unknown; rules?: readonly string[] };
};

/** Whether `after` is `before` with only the span [start, end) of `after` new: every byte before it and after it is
 *  the person's, exactly as it was (numbers, escapes, key order, line endings: what parsing would lose). */
export function onlySpanChanged(before: string, after: string, span: { start: number; end: number }): boolean {
  const tail = after.length - span.end;
  return span.start + tail <= before.length && after.slice(0, span.start) === before.slice(0, span.start) && after.slice(span.end) === before.slice(before.length - tail);
}

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

/** Whether `after` is `before` (an absent file is `{}`) with only setup's entries added, replaced or made, and those
 *  entries are this run's values. */
export function keptApartFromSetup(before: string | undefined, after: string, m: Marks): boolean {
  try {
    const b = before === undefined ? {} : (JSON.parse(before) as Obj);
    const a = JSON.parse(after) as unknown;
    if (!isObject(a) || !jsonEqual(withoutSetup(b, m, false), withoutSetup(a, m, true))) return false;
    const v = m.values ?? {};
    const servers = own(a, 'mcpServers');
    if (v.mcp !== undefined && !(isObject(servers) && jsonEqual(own(servers, SERVER_NAME), v.mcp))) return false;
    const hooks = own(a, 'hooks');
    const groups = isObject(hooks) ? own(hooks, 'SessionStart') : undefined;
    if (v.hook !== undefined && m.hook && !(Array.isArray(groups) && jsonEqual(groups[m.hook.index], v.hook))) return false;
    const permissions = own(a, 'permissions');
    const allow = isObject(permissions) ? own(permissions, 'allow') : undefined;
    if (v.rules !== undefined && m.rulesAppended && !(Array.isArray(allow) && jsonEqual(allow.slice(allow.length - m.rulesAppended), v.rules))) return false;
    return true;
  } catch {
    return false;
  }
}

/** Splices made one after another, each checked to leave every byte outside its own span as it was. */
class Splices {
  text: string;
  ok = true;
  constructor(text: string) {
    this.text = text;
  }
  add(next: Spliced): void {
    this.ok &&= onlySpanChanged(this.text, next.text, next);
    this.text = next.text;
  }
  /** A value replaced in place: its span is the new value's text where the old one's was. */
  replace(node: JsonNode, next: string): void {
    this.add({ text: next, start: node.start, end: node.end + next.length - this.text.length });
  }
}

const checked = (before: string | undefined, text: string, spansKept: boolean, m: Marks, entries: PlannedEntry[]): Merged =>
  spansKept && keptApartFromSetup(before, text, m) ? { text, entries } : { refusal: { code: 'internal_error' } };

/** `.claude.json`: `mcpServers["skills-catalog"]` only. `recorded` is the record's entries in this file. */
export function mergeClaudeJson(before: string | undefined, entry: Obj, recorded: readonly RecordEntry[]): Merged {
  const ours = recorded.find((e) => e.kind === 'mcp_entry');
  const planned = (created?: Container[]) => [withCreated({ kind: 'mcp_entry', value: entry }, union(ours?.created, created))];
  const values = { mcp: entry };
  if (before === undefined) return checked(before, freshText({ mcpServers: { [SERVER_NAME]: entry } }), true, { mcp: 'inserted', created: ['mcpServers'], values }, planned(['mcpServers']));

  const s = scan(before, CLAUDE_ONCE);
  if ('refusal' in s) return s;
  const servers = own(s.value, 'mcpServers');
  if (servers !== undefined && !isObject(servers)) return wrongType('mcpServers');
  const current = isObject(servers) ? own(servers, SERVER_NAME) : undefined;
  if (current !== undefined && !isObject(current)) return wrongType(`mcpServers.${SERVER_NAME}`);

  const edit = new Splices(before);
  if (servers === undefined) {
    edit.add(insertMember(before, s.root, 'mcpServers', { [SERVER_NAME]: entry }));
    return checked(before, edit.text, edit.ok, { mcp: 'inserted', created: ['mcpServers'], values }, planned(['mcpServers']));
  }
  const box = container(s.root, 'mcpServers');
  if (current === undefined) {
    edit.add(insertMember(before, box, SERVER_NAME, entry));
    return checked(before, edit.text, edit.ok, { mcp: 'inserted', created: [], values }, planned());
  }
  if (jsonEqual(current, entry)) return { text: undefined, entries: planned() };
  if (ours && jsonEqual(current, ours.value)) {
    const node = member(box, SERVER_NAME)!;
    edit.replace(node, replaceValue(before, node, entry, box));
    return checked(before, edit.text, edit.ok, { mcp: 'replaced', created: [], values }, planned());
  }
  return { refusal: { code: 'name_taken', name: SERVER_NAME } };
}

/** `.claude/settings.json`: one group in `hooks.SessionStart` and the allow rules in `permissions.allow`. */
export function mergeSettingsJson(before: string | undefined, want: { hook: Obj; rules: readonly string[]; id: string }, recorded: readonly RecordEntry[]): Merged {
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
    const marks: Marks = { hook: { index: 0, replaced: false }, rulesAppended: want.rules.length, created, values: { hook: want.hook, rules: want.rules } };
    return checked(before, text, true, marks, [hookEntry(['hooks', 'hooks.SessionStart']), ...ruleEntries([], want.rules, ['permissions', 'permissions.allow'])]);
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

  // A group carrying this setup id is setup's: one that's neither this run's nor the recorded one is setup's the person
  // changed since, so the run is refused (contract §6), as for the MCP entry. No one else's group carries the id.
  const carriesId = (g: unknown) => JSON.stringify(g).includes(`--setup-id ${want.id}`);
  if (groups?.some((g) => carriesId(g) && !jsonEqual(g, want.hook) && !(ourHook && jsonEqual(g, ourHook.value)))) return { refusal: { code: 'name_taken', name: SERVER_NAME } };

  // The hook group: there → nothing; setup's recorded one → replaced in place; else appended, making what's missing.
  const edit = new Splices(before);
  const marks: Marks = { created: [], values: { hook: want.hook } };
  let hookMade: Container[] | undefined;
  if (groups === undefined) {
    hookMade = hooks === undefined ? ['hooks', 'hooks.SessionStart'] : ['hooks.SessionStart'];
    edit.add(hooks === undefined ? insertMember(before, s.root, 'hooks', { SessionStart: [want.hook] }) : insertMember(before, container(s.root, 'hooks'), 'SessionStart', [want.hook]));
    marks.hook = { index: 0, replaced: false };
    marks.created.push(...hookMade);
  } else if (!groups.some((g) => jsonEqual(g, want.hook))) {
    const box = container(container(s.root, 'hooks'), 'SessionStart');
    const at = ourHook ? groups.findIndex((g) => jsonEqual(g, ourHook.value)) : -1;
    if (at >= 0 && box.kind === 'array') edit.replace(box.items[at]!, replaceValue(before, box.items[at]!, want.hook, box));
    else edit.add(appendItem(before, box, want.hook));
    marks.hook = { index: at >= 0 ? at : groups.length, replaced: at >= 0 };
  }

  // The allow rules: each one missing appended, making what's missing.
  const inFile = Array.isArray(allow) ? allow : [];
  const missing = want.rules.filter((r) => !inFile.includes(r));
  let rulesMade: Container[] | undefined;
  if (missing.length) {
    if (edit.text !== before) {
      const again = scan(edit.text, SETTINGS_ONCE);
      if ('refusal' in again) return { refusal: { code: 'internal_error' } };
      s = again;
    }
    if (permissions === undefined) {
      rulesMade = ['permissions', 'permissions.allow'];
      edit.add(insertMember(edit.text, s.root, 'permissions', { allow: missing }));
    } else if (allow === undefined) {
      rulesMade = ['permissions.allow'];
      edit.add(insertMember(edit.text, container(s.root, 'permissions'), 'allow', missing));
    } else {
      for (const r of missing) {
        const now = scan(edit.text, SETTINGS_ONCE);
        if ('refusal' in now) return { refusal: { code: 'internal_error' } };
        edit.add(appendItem(edit.text, container(container(now.root, 'permissions'), 'allow'), r));
      }
    }
    marks.rulesAppended = missing.length;
    marks.values!.rules = missing;
    marks.created.push(...(rulesMade ?? []));
  }

  const entries = [hookEntry(hookMade), ...ruleEntries(inFile, missing, rulesMade)];
  return edit.text === before ? { text: undefined, entries } : checked(before, edit.text, edit.ok, marks, entries);
}
