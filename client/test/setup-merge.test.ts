// Setup's merge of its own entries into each assistant file (setup build notes §2, byte pins 1-6): absent → added, equal
// to this run's → nothing, equal to the record's → replaced in place, anything else under the name → name_taken; the hook
// group appended unless it's there; each allow rule appended unless it's there (then "was there", unless the record says
// it's setup's); missing containers made last in their parent, hooks before permissions; a key twice or a wrong type on
// setup's path refused; after every splice, the file without setup's entries must equal the file before.
import { describe, expect, it } from 'vitest';
import type { Container, RecordEntry } from '../src/machine/setup-record.ts';
import { keptApartFromSetup, mergeClaudeJson, mergeSettingsJson, onlySpanChanged, type Merged, type PlannedEntry } from '../src/machine/setup-merge.ts';
import { fileOf, golden, HOOK_GROUP, LINE, MCP_ENTRY, RULES } from './setup-golden.ts';

const CLAUDE = '/a/.claude.json';
const SETTINGS = '/a/.claude/settings.json';
const ID = '0123456789abcdef0123456789abcdef';
const WANT = { hook: HOOK_GROUP, rules: RULES, id: ID };
const NODE2 = '/opt/node2/bin/node';
const MCP_ENTRY2 = { ...MCP_ENTRY, command: NODE2 };
const LINE2 = 'the hook line, node moved';
const HOOK_GROUP2 = { hooks: [{ type: 'command', command: LINE2, timeout: 10 }] };

/** A plan's entries as the record lists them once written. */
const recorded = (file: string, entries: PlannedEntry[]): RecordEntry[] => entries.map((e) => ({ ...e, file, state: 'written' }) as RecordEntry);
const done = (m: Merged) => {
  if ('refusal' in m) throw new Error(`refused: ${JSON.stringify(m.refusal)}`);
  return m;
};
const rule = (value: string, was_there = false, created?: string[]) => ({ kind: 'allow_rule', value, was_there, ...(created ? { created } : {}) });

describe('setup\'s merge into .claude.json (golden setup.yaml)', () => {
  it('fresh: the pinned file with the entry, mcpServers recorded as made', () => {
    const m = done(mergeClaudeJson(undefined, MCP_ENTRY, []));
    expect(m.text).toBe(fileOf(golden.fresh.claude_json));
    expect(m.entries).toEqual([{ kind: 'mcp_entry', value: MCP_ENTRY, created: ['mcpServers'] }]);
  });

  it('other keys kept: only the entry\'s span is new', () => {
    const m = done(mergeClaudeJson(fileOf(golden.kept_input.claude_json), MCP_ENTRY, []));
    expect(m.text).toBe(fileOf(golden.kept_expected.claude_json));
    expect(m.entries).toEqual([{ kind: 'mcp_entry', value: MCP_ENTRY }]);
  });

  it('a file without mcpServers gets it last, recorded as made', () => {
    const m = done(mergeClaudeJson('{\n  "projects": {}\n}\n', MCP_ENTRY, []));
    expect(Object.keys(JSON.parse(m.text!))).toEqual(['projects', 'mcpServers']);
    expect(m.text!.startsWith('{\n  "projects": {},\n  "mcpServers": {\n    "skills-catalog": {\n')).toBe(true);
    expect(m.entries[0]!.created).toEqual(['mcpServers']);
  });

  it('rerun: nothing to write, and the record\'s entry kept as it was (what setup made included)', () => {
    const first = done(mergeClaudeJson(undefined, MCP_ENTRY, []));
    const again = done(mergeClaudeJson(first.text, MCP_ENTRY, recorded(CLAUDE, first.entries)));
    expect(again.text).toBeUndefined();
    expect(again.entries).toEqual(first.entries);
  });

  it('node moved: the recorded entry replaced at the same place, what setup made kept', () => {
    const before = fileOf(golden.kept_expected.claude_json);
    const m = done(mergeClaudeJson(before, MCP_ENTRY2, recorded(CLAUDE, [{ kind: 'mcp_entry', value: MCP_ENTRY, created: ['mcpServers'] }])));
    expect(m.text).toBe(before.replace('"command": "/opt/node/bin/node"', `"command": "${NODE2}"`));
    expect(m.entries).toEqual([{ kind: 'mcp_entry', value: MCP_ENTRY2, created: ['mcpServers'] }]);
  });

  it('a skills-catalog server setup didn\'t write, or setup\'s the person changed: name_taken', () => {
    const theirs = golden.cases.find((c: { id: string }) => c.id === 'name-taken').before.claude_json.text as string;
    expect(mergeClaudeJson(theirs, MCP_ENTRY, [])).toEqual({ refusal: { code: 'name_taken', name: 'skills-catalog' } });
    const fresh = fileOf(golden.fresh.claude_json);
    const edited = fresh.replace('"mcp"', '"serve"');
    expect(edited).not.toBe(fresh);
    expect(mergeClaudeJson(edited, MCP_ENTRY, recorded(CLAUDE, [{ kind: 'mcp_entry', value: MCP_ENTRY }]))).toEqual({ refusal: { code: 'name_taken', name: 'skills-catalog' } });
    // The record's entry doesn't make an unequal one setup's for this run either.
    expect(mergeClaudeJson(edited, MCP_ENTRY2, recorded(CLAUDE, [{ kind: 'mcp_entry', value: MCP_ENTRY }]))).toEqual({ refusal: { code: 'name_taken', name: 'skills-catalog' } });
  });

  it('a key twice or a wrong type on setup\'s path is refused with the key; the same elsewhere is the person\'s', () => {
    for (const [text, why, key] of [
      ['{"mcpServers": {}, "mcpServers": {}}', 'duplicate_key', 'mcpServers'],
      ['{"mcpServers": {"skills-catalog": {}, "skills-catalog": {}}}', 'duplicate_key', 'skills-catalog'],
      ['{"mcpServers": []}', 'wrong_type', 'mcpServers'],
      ['{"mcpServers": null}', 'wrong_type', 'mcpServers'],
      ['{"mcpServers": {"skills-catalog": "x"}}', 'wrong_type', 'mcpServers.skills-catalog'],
    ] as const) {
      expect(mergeClaudeJson(text, MCP_ENTRY, []), text).toEqual({ refusal: { code: 'assistant_file_unusable', why, key } });
    }
    for (const text of ['{"hooks": [], "permissions": "x", "other": 1, "other": 2}', '{"mcpServers": {"x": 1, "x": 2}}']) expect('refusal' in mergeClaudeJson(text, MCP_ENTRY, []), text).toBe(false);
  });
});

describe('setup\'s merge into settings.json (golden setup.yaml)', () => {
  it('fresh: the pinned file, hooks then permissions, each container recorded as made once', () => {
    const m = done(mergeSettingsJson(undefined, WANT, []));
    expect(m.text).toBe(fileOf(golden.fresh.settings_json));
    expect(m.entries).toEqual([
      { kind: 'hook_group', value: HOOK_GROUP, created: ['hooks', 'hooks.SessionStart'] },
      rule(RULES[0]!, false, ['permissions', 'permissions.allow']),
      ...RULES.slice(1).map((r) => rule(r)),
    ]);
  });

  it('other keys kept: the group appended after the person\'s, the rules after theirs', () => {
    const m = done(mergeSettingsJson(fileOf(golden.kept_input.settings_json), WANT, []));
    expect(m.text).toBe(fileOf(golden.kept_expected.settings_json));
    expect(m.entries).toEqual([{ kind: 'hook_group', value: HOOK_GROUP }, ...RULES.map((r) => rule(r))]);
  });

  it('missing containers go last in their parent, hooks before permissions (pin 4)', () => {
    const m = done(mergeSettingsJson('{\n  "model": "opus"\n}\n', { hook: HOOK_GROUP, rules: ['A'], id: ID }, []));
    expect(m.text).toBe(`{\n  "model": "opus",\n  "hooks": {\n    "SessionStart": [\n      {\n        "hooks": [\n          {\n            "type": "command",\n            "command": "${LINE}",\n            "timeout": 10\n          }\n        ]\n      }\n    ]\n  },\n  "permissions": {\n    "allow": [\n      "A"\n    ]\n  }\n}\n`);
    const inner = done(mergeSettingsJson('{"hooks": {"x": 1}, "permissions": {"deny": []}}', { hook: HOOK_GROUP, rules: ['A'], id: ID }, []));
    expect(Object.keys(JSON.parse(inner.text!).hooks)).toEqual(['x', 'SessionStart']);
    expect(Object.keys(JSON.parse(inner.text!).permissions)).toEqual(['deny', 'allow']);
    expect(inner.entries).toEqual([{ kind: 'hook_group', value: HOOK_GROUP, created: ['hooks.SessionStart'] }, rule('A', false, ['permissions.allow'])]);
  });

  it('rerun: nothing to write, the entries kept as recorded', () => {
    const first = done(mergeSettingsJson(undefined, WANT, []));
    const again = done(mergeSettingsJson(first.text, WANT, recorded(SETTINGS, first.entries)));
    expect(again.text).toBeUndefined();
    expect(again.entries).toEqual(first.entries);
  });

  it('an equal group or entry laid out another way is left as the person has it', () => {
    const settings = `{"hooks": {"SessionStart": [${JSON.stringify(HOOK_GROUP)}]}, "permissions": {"allow": ${JSON.stringify(RULES)}}}`;
    const s = done(mergeSettingsJson(settings, WANT, recorded(SETTINGS, [{ kind: 'hook_group', value: HOOK_GROUP }, ...RULES.map((r) => rule(r) as PlannedEntry)])));
    expect(s.text).toBeUndefined();
    const claude = `{"mcpServers": {"skills-catalog": ${JSON.stringify(MCP_ENTRY)}}}`;
    expect(done(mergeClaudeJson(claude, MCP_ENTRY, recorded(CLAUDE, [{ kind: 'mcp_entry', value: MCP_ENTRY }]))).text).toBeUndefined();
  });

  it('node moved: the recorded group replaced at the same place', () => {
    const before = fileOf(golden.kept_expected.settings_json);
    const m = done(mergeSettingsJson(before, { hook: HOOK_GROUP2, rules: RULES, id: ID }, recorded(SETTINGS, [{ kind: 'hook_group', value: HOOK_GROUP }, ...RULES.map((r) => rule(r) as PlannedEntry)])));
    expect(m.text).toBe(before.replace(`"command": "${LINE}"`, `"command": "${LINE2}"`));
    expect(m.entries[0]).toEqual({ kind: 'hook_group', value: HOOK_GROUP2 });
  });

  it('setup\'s group the person changed (it carries this setup id, but is neither this run\'s nor the recorded one): name_taken, nothing changed', () => {
    const ours = { hooks: [{ type: 'command', command: `'/n' '/s' hook session-start --setup-id ${ID} 2>/dev/null || true`, timeout: 10 }] };
    const want = { hook: ours, rules: RULES, id: ID };
    const first = done(mergeSettingsJson(undefined, want, []));
    const edited = first.text!.replace('"timeout": 10', '"timeout": 5');
    expect(mergeSettingsJson(edited, want, recorded(SETTINGS, first.entries))).toEqual({ refusal: { code: 'name_taken', name: 'skills-catalog' } });
    // Without a record too: the id is setup's alone.
    expect(mergeSettingsJson(edited, want, [])).toEqual({ refusal: { code: 'name_taken', name: 'skills-catalog' } });
    // The person's own group, even one that looks like setup's, never carries this id: left, and this run's added.
    const theirs = edited.replace(ID, 'fedcba9876543210fedcba9876543210');
    expect(JSON.parse(done(mergeSettingsJson(theirs, want, [])).text!).hooks.SessionStart).toHaveLength(2);
  });

  it('a person\'s group after setup\'s: setup\'s is found wherever it sits, so a rerun writes nothing', () => {
    const first = done(mergeSettingsJson(undefined, WANT, []));
    const theirs = { matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] };
    // Setup's group on one line, as the person's editor may have left it: found as it is, never laid out again.
    const withTheirs = `{"hooks": {"SessionStart": [${JSON.stringify(HOOK_GROUP)}, ${JSON.stringify(theirs)}]}, "permissions": {"allow": ${JSON.stringify(RULES)}}}`;
    expect(done(mergeSettingsJson(withTheirs, WANT, recorded(SETTINGS, first.entries))).text).toBeUndefined();
  });

  it('a rule a crash left pending in the record is setup\'s: not "was there", so teardown still takes it out', () => {
    const first = done(mergeSettingsJson(undefined, WANT, []));
    const pending = recorded(SETTINGS, first.entries).map((e) => ({ ...e, state: 'pending' as const }));
    const again = done(mergeSettingsJson(first.text, WANT, pending));
    expect(again.text).toBeUndefined();
    expect(again.entries.filter((e) => e.was_there)).toEqual([]);
  });

  it('what setup made for the rules goes on a rule that\'s setup\'s, never on one that was there', () => {
    const first = done(mergeSettingsJson(undefined, WANT, []));
    // The record says the first rule was there before setup (the person had it), and setup made the containers.
    const made: Container[] = ['permissions', 'permissions.allow'];
    const entries: PlannedEntry[] = [{ kind: 'hook_group', value: HOOK_GROUP }, rule(RULES[0]!, true) as PlannedEntry, rule(RULES[1]!, false, made) as PlannedEntry, ...RULES.slice(2).map((r) => rule(r) as PlannedEntry)];
    const again = done(mergeSettingsJson(first.text, WANT, recorded(SETTINGS, entries)));
    const rules = again.entries.filter((e) => e.kind === 'allow_rule');
    expect(rules[0]).toEqual(rule(RULES[0]!, true));
    expect(rules[1]).toEqual(rule(RULES[1]!, false, ['permissions', 'permissions.allow']));
  });

  it('allow rules: one already there is "was there" and not added again, unless the record says it\'s setup\'s', () => {
    const text = '{\n  "permissions": {\n    "allow": [\n      "Bash(skills-catalog update)"\n    ]\n  }\n}\n';
    const m = done(mergeSettingsJson(text, WANT, []));
    expect(JSON.parse(m.text!).permissions.allow).toEqual(['Bash(skills-catalog update)', ...RULES.slice(0, -1)]);
    expect(m.entries.filter((e) => e.kind === 'allow_rule')).toEqual([...RULES.slice(0, -1).map((r) => rule(r)), rule('Bash(skills-catalog update)', true)]);
    // Rerun with that record: nothing to write; the rule stays "was there", the rest setup's.
    const again = done(mergeSettingsJson(m.text, WANT, recorded(SETTINGS, m.entries)));
    expect(again.text).toBeUndefined();
    expect(again.entries).toEqual(m.entries);
  });

  it('a rule setup added that this run doesn\'t want stays recorded while it\'s in the file, so teardown can take it out', () => {
    const extra = 'Bash(skills-catalog search *)';
    const first = done(mergeSettingsJson(undefined, { hook: HOOK_GROUP, rules: [...RULES, extra], id: ID }, []));
    const again = done(mergeSettingsJson(first.text, WANT, recorded(SETTINGS, first.entries)));
    expect(again.text).toBeUndefined();
    expect(again.entries.at(-1)).toEqual(rule(extra));
    // Once the person took it out, it's no longer recorded.
    const gone = first.text!.replace(`,\n      "${extra}"`, '');
    expect(JSON.parse(gone).permissions.allow).toEqual(RULES);
    const after = done(mergeSettingsJson(gone, WANT, recorded(SETTINGS, first.entries)));
    expect(after.entries.map((e) => e.value)).not.toContain(extra);
  });

  it('a key twice or a wrong type on setup\'s path is refused with the key; mcpServers here is the person\'s', () => {
    for (const [text, why, key] of [
      ['{"hooks": {}, "hooks": {}}', 'duplicate_key', 'hooks'],
      ['{"hooks": {"SessionStart": [], "SessionStart": []}}', 'duplicate_key', 'SessionStart'],
      ['{"permissions": {"allow": [], "allow": []}}', 'duplicate_key', 'allow'],
      ['{"hooks": []}', 'wrong_type', 'hooks'],
      ['{"hooks": {"SessionStart": {}}}', 'wrong_type', 'hooks.SessionStart'],
      ['{"permissions": "x"}', 'wrong_type', 'permissions'],
      ['{"permissions": {"allow": "x"}}', 'wrong_type', 'permissions.allow'],
    ] as const) {
      expect(mergeSettingsJson(text, WANT, []), text).toEqual({ refusal: { code: 'assistant_file_unusable', why, key } });
    }
    expect('refusal' in mergeSettingsJson('{"mcpServers": [], "x": 1, "x": 2}', WANT, [])).toBe(false);
  });
});

describe('the byte check after every splice: every byte outside setup\'s span is the person\'s, as it was', () => {
  it('holds for the splice as made, and fails for any change outside the span that parses the same', () => {
    const before = fileOf(golden.kept_input.claude_json);
    const after = fileOf(golden.kept_expected.claude_json);
    // Setup's span in the text after: an insert, from where the texts first differ, as long as what it added.
    let start = 0;
    while (before[start] === after[start]) start++;
    const span = { start, end: start + (after.length - before.length) };
    expect(onlySpanChanged(before, after, span)).toBe(true);
    for (const [from, to] of [
      ['12345678901234567890', '12345678901234567891'],
      ['"ratio": 1.0', '"ratio": 1'],
      ['\\u00e9 é', 'é é'],
      ['\r\n', '\n'],
      ['"10": "ten",\r\n\t"2": "two"', '"2": "two",\r\n\t"10": "ten"'],
    ]) {
      expect(onlySpanChanged(before, after.replace(from!, to!), span), from).toBe(false);
    }
    // After the span too.
    expect(onlySpanChanged(before, `${after.slice(0, -1)}]`, span), 'after the span, same length').toBe(false);
  });

  it('a run\'s own values must be what it put at setup\'s places', () => {
    const before = fileOf(golden.kept_input.settings_json);
    const after = fileOf(golden.kept_expected.settings_json);
    const marks = { hook: { index: 1, replaced: false }, rulesAppended: RULES.length, created: [], values: { hook: HOOK_GROUP, rules: RULES } };
    expect(keptApartFromSetup(before, after, marks)).toBe(true);
    expect(keptApartFromSetup(before, after.replace('"Bash(skills-catalog update)"', '"Bash(skills-catalog *)"'), marks)).toBe(false);
    expect(keptApartFromSetup(before, after.replace('"timeout": 10', '"timeout": 11'), marks)).toBe(false);
    const c0 = fileOf(golden.kept_input.claude_json);
    const c1 = fileOf(golden.kept_expected.claude_json);
    expect(keptApartFromSetup(c0, c1.replace('"mcp"', '"serve"'), { mcp: 'inserted', created: [], values: { mcp: MCP_ENTRY } })).toBe(false);
  });
});

describe('the check after every splice (build notes §2)', () => {
  it('holds when only setup\'s entries differ, and fails when a byte of the person\'s changed', () => {
    const before = fileOf(golden.kept_input.claude_json);
    const after = fileOf(golden.kept_expected.claude_json);
    const marks = { mcp: 'inserted' as const, created: [] };
    expect(keptApartFromSetup(before, after, marks)).toBe(true);
    expect(keptApartFromSetup(before, after.replace('"ratio": 1.0', '"ratio": 2.0'), marks)).toBe(false);
    expect(keptApartFromSetup(before, after.replace('"other"', '"other2"'), marks)).toBe(false);
    // The settings file: the group at its index, the rules at the end, made containers.
    const s0 = fileOf(golden.kept_input.settings_json);
    const s1 = fileOf(golden.kept_expected.settings_json);
    const smarks = { hook: { index: 1, replaced: false }, rulesAppended: RULES.length, created: [] };
    expect(keptApartFromSetup(s0, s1, smarks)).toBe(true);
    expect(keptApartFromSetup(s0, s1.replace('"Bash(git *)"', '"Bash(git push *)"'), smarks)).toBe(false);
    expect(keptApartFromSetup(s0, s1, { ...smarks, rulesAppended: RULES.length - 1 })).toBe(false);
    expect(keptApartFromSetup(undefined, fileOf(golden.fresh.settings_json), { hook: { index: 0, replaced: false }, rulesAppended: RULES.length, created: ['hooks', 'hooks.SessionStart', 'permissions', 'permissions.allow'] })).toBe(true);
  });
});
