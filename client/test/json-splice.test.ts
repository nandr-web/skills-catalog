// Setup's edits to the person's assistant files, by splicing text (setup build notes §2 and its byte pins): a member or
// item goes last in its container, laid out as JSON.stringify at the container's indent step with the file's own line
// ending; every byte outside the spliced span stays; removing what was inserted gives the file back byte for byte.
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { scanJson, type JsonContainer, type JsonNode } from '../src/machine/json-text.ts';
import { appendItem, freshText, insertMember, removeItem, removeMember, replaceValue } from '../src/machine/json-splice.ts';

const golden = loadGolden('setup.yaml').setup as Record<string, any>;
// The golden's placeholders, filled with fixed values.
const FILL: [string, string][] = [['<node>', '/opt/node/bin/node'], ['<script>', '/opt/pkg/cli.ts'], ['<id>', '0123456789abcdef0123456789abcdef'], ['$H', '/h'], ['$A', '/a'], ['$M', '/m']];
const LINE = 'the hook line';
const fill = (s: string) => FILL.reduce((t, [k, v]) => t.split(k).join(v), s).split('<line>').join(LINE);
// A golden file: {text, crlf?, final_newline?}, or plain text.
const fileOf = (f: string | { text: string; crlf?: boolean; final_newline?: boolean }) => {
  const g = typeof f === 'string' ? { text: f } : f;
  let t = fill(g.text);
  if (g.final_newline === false) t = t.replace(/\n$/, '');
  return g.crlf ? t.replace(/\n/g, '\r\n') : t;
};
const MCP_ENTRY = JSON.parse(fill(golden.mcp_entry));
const HOOK_GROUP = { hooks: [{ type: 'command', command: LINE, timeout: 10 }] };
const RULES = golden.allow_rules as string[];

const everything = () => true;
const at = (text: string, ...keys: string[]): JsonContainer => {
  let n: JsonNode = scanJson(text, everything);
  for (const k of keys) {
    if (n.kind !== 'object') throw new Error(`no ${k}`);
    n = n.members.find((m) => m.key === k)!.value;
  }
  if (n.kind !== 'object' && n.kind !== 'array') throw new Error('not a container');
  return n;
};

describe('setup\'s edits by splicing (golden setup.yaml)', () => {
  it('a fresh file is the pinned layout: 2 spaces, LF, a final LF', () => {
    expect(freshText({ mcpServers: { 'skills-catalog': MCP_ENTRY } })).toBe(fileOf(golden.fresh.claude_json));
    expect(freshText({ hooks: { SessionStart: [HOOK_GROUP] }, permissions: { allow: RULES } })).toBe(fileOf(golden.fresh.settings_json));
  });

  it('the kept files: only setup\'s spans change (tabs, CRLF, no final newline; 4 spaces)', () => {
    const claude = fileOf(golden.kept_input.claude_json);
    expect(insertMember(claude, at(claude, 'mcpServers'), 'skills-catalog', MCP_ENTRY).text).toBe(fileOf(golden.kept_expected.claude_json));

    let settings = fileOf(golden.kept_input.settings_json);
    settings = appendItem(settings, at(settings, 'hooks', 'SessionStart'), HOOK_GROUP).text;
    for (const rule of RULES) settings = appendItem(settings, at(settings, 'permissions', 'allow'), rule).text;
    expect(settings).toBe(fileOf(golden.kept_expected.settings_json));
  });

  it('removing what was inserted gives the file back byte for byte', () => {
    const claude = fileOf(golden.kept_input.claude_json);
    const withEntry = insertMember(claude, at(claude, 'mcpServers'), 'skills-catalog', MCP_ENTRY).text;
    expect(removeMember(withEntry, at(withEntry, 'mcpServers'), 'skills-catalog')).toBe(claude);

    const settings = fileOf(golden.kept_input.settings_json);
    const withGroup = appendItem(settings, at(settings, 'hooks', 'SessionStart'), HOOK_GROUP).text;
    expect(removeItem(withGroup, at(withGroup, 'hooks', 'SessionStart'), 1)).toBe(settings);
  });

  it('a container that is empty or on one line: the line\'s indent plus 2 spaces; emptied again, it\'s as it was', () => {
    for (const [text, expected] of [
      ['{\n  "mcpServers": {}\n}\n', '{\n  "mcpServers": {\n    "x": 1\n  }\n}\n'],
      ['{\n  "mcpServers": { }\n}\n', '{\n  "mcpServers": {\n    "x": 1\n  }\n}\n'],
      ['{"mcpServers": {"a": 1}}', '{"mcpServers": {"a": 1,\n  "x": 1}}'],
      ['{}', '{\n  "x": 1\n}'],
    ] as const) {
      const container = text.includes('mcpServers') ? at(text, 'mcpServers') : at(text);
      const inserted = insertMember(text, container, 'x', 1);
      expect(inserted.text, text).toBe(expected);
      const after = text.includes('mcpServers') ? at(inserted.text, 'mcpServers') : at(inserted.text);
      expect(removeMember(inserted.text, after, 'x', inserted.interior), text).toBe(text);
    }
  });

  it('a value replaced in place keeps its position and the container\'s layout', () => {
    const settings = fileOf(golden.kept_expected.settings_json);
    const group = at(settings, 'hooks', 'SessionStart');
    const moved = { hooks: [{ type: 'command', command: 'another line', timeout: 10 }] };
    const out = replaceValue(settings, group.kind === 'array' ? group.items[1]! : group, moved, group);
    expect(out).toBe(settings.replace(`"command": "${LINE}"`, '"command": "another line"'));
  });

  it('removes a member that isn\'t last, or is the first, leaving the rest byte for byte', () => {
    const text = '{\r\n\t"a": 1,\r\n\t"b": [2],\r\n\t"c": 3\r\n}';
    expect(removeMember(text, at(text), 'b')).toBe('{\r\n\t"a": 1,\r\n\t"c": 3\r\n}');
    expect(removeMember(text, at(text), 'a')).toBe('{\r\n\t"b": [2],\r\n\t"c": 3\r\n}');
  });

  it('generated files: insert then remove gives back the input, and nothing outside the span changes', () => {
    let seed = 11;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    for (let c = 0; c < 200; c++) {
      const eol = pick(['\n', '\r\n']);
      const unit = pick(['  ', '    ', '\t']);
      const others = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => `${unit}${unit}"k${i}": ${pick(['1.0', '"\\u00e9"', '12345678901234567890', '[]', '{"x": {}}'])}`);
      const inner = others.length ? `{${eol}${others.join(`,${eol}`)}${eol}${unit}}` : pick(['{}', '{ }', `{${eol}${unit}}`]);
      const text = `{${eol}${unit}"a": 1,${eol}${unit}"mcpServers": ${inner}${eol}}${pick(['', eol])}`;
      const inserted = insertMember(text, at(text, 'mcpServers'), 'skills-catalog', MCP_ENTRY);
      const parsed = JSON.parse(inserted.text);
      expect(parsed.mcpServers['skills-catalog']).toEqual(MCP_ENTRY);
      delete parsed.mcpServers['skills-catalog'];
      expect(parsed).toEqual(JSON.parse(text));
      expect(inserted.text.slice(0, inserted.start) + inserted.text.slice(inserted.end)).toBe(others.length ? text : inserted.text.slice(0, inserted.start) + inserted.text.slice(inserted.end));
      expect(removeMember(inserted.text, at(inserted.text, 'mcpServers'), 'skills-catalog', inserted.interior)).toBe(text);
    }
  });
});
