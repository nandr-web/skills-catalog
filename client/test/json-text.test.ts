// Where each value sits in a JSON file's text, for setup's edits by splicing (setup build notes §2): strict JSON only, a
// key that appears twice on setup's path refused, spans kept only for the containers on that path, and no depth that can
// overflow the stack.
import { describe, expect, it } from 'vitest';
import { JsonTextError, scanJson, type JsonNode } from '../src/machine/json-text.ts';

// Setup's path: the root, mcpServers and skills-catalog in it, hooks and SessionStart in it, permissions and allow in it.
const PATH = [[], ['mcpServers'], ['mcpServers', 'skills-catalog'], ['hooks'], ['hooks', 'SessionStart'], ['permissions'], ['permissions', 'allow']];
const onPath = (path: readonly string[]) => PATH.some((p) => p.length === path.length && p.every((k, i) => k === path[i]));
const DUPLICATE_KEYS = { '': ['mcpServers', 'hooks', 'permissions'], mcpServers: ['skills-catalog'], hooks: ['SessionStart'], permissions: ['allow'] };
const scan = (text: string) => scanJson(text, onPath, DUPLICATE_KEYS);
const slice = (text: string, n: JsonNode) => text.slice(n.start, n.end);
const member = (n: JsonNode, key: string) => (n.kind === 'object' ? n.members.find((m) => m.key === key) : undefined);

describe('where each value sits in a JSON file', () => {
  it('gives each member of a container on the path its key and value spans, exactly as written', () => {
    const text = '{\r\n\t"a": 1.0,\r\n\t"mcpServers" : { "x": {"command": "n\\"ode"}, "skills-catalog": [1, {"b": "}"}] },\r\n\t"hooks": {"SessionStart": [ {"hooks": []} , 2 ]}\r\n}';
    const root = scan(text);
    expect(root.kind).toBe('object');
    expect(slice(text, member(root, 'a')!.value)).toBe('1.0');
    const servers = member(root, 'mcpServers')!.value;
    expect(slice(text, servers)).toBe('{ "x": {"command": "n\\"ode"}, "skills-catalog": [1, {"b": "}"}] }');
    expect(slice(text, member(servers, 'x')!.value)).toBe('{"command": "n\\"ode"}');
    expect(slice(text, member(servers, 'skills-catalog')!.value)).toBe('[1, {"b": "}"}]');
    const start = member(member(root, 'hooks')!.value, 'SessionStart')!.value;
    expect(start.kind === 'array' && start.items.map((i) => slice(text, i))).toEqual(['{"hooks": []}', '2']);
    // A member's own span runs from its key to the end of its value.
    const a = member(root, 'a')!;
    expect(text.slice(a.start, a.value.end)).toBe('"a": 1.0');
  });

  it('keeps no members for a container off the path, however large', () => {
    const text = JSON.stringify({ other: Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`k${i}`, i])), mcpServers: {} });
    const root = scan(text);
    const other = member(root, 'other')!.value;
    expect(other.kind === 'object' && other.members).toEqual([]);
    expect(JSON.parse(slice(text, other))).toEqual(JSON.parse(text).other);
  });

  it('reads a very deep file off the path without overflowing the stack', () => {
    const depth = 200_000;
    const text = `{"deep": ${'['.repeat(depth)}${']'.repeat(depth)}, "hooks": {}}`;
    const root = scan(text);
    expect(slice(text, member(root, 'hooks')!.value)).toBe('{}');
  });

  it('refuses a key that appears twice on setup\'s path; the same key twice elsewhere is the person\'s own', () => {
    for (const [text, key] of [
      ['{"mcpServers": {}, "mcpServers": {}}', 'mcpServers'],
      ['{"mcpServers": {"skills-catalog": {}, "skills-catalog": 1}}', 'skills-catalog'],
      ['{"hooks": {"SessionStart": [], "SessionStart": []}}', 'SessionStart'],
      ['{"permissions": {"allow": [], "allow": []}}', 'allow'],
    ] as const) {
      expect(() => scan(text), text).toThrowError(expect.objectContaining({ why: 'duplicate_key', key }));
    }
    expect(() => scan('{"other": 1, "other": 2, "mcpServers": {"x": 1, "x": 2}}')).not.toThrow();
  });

  it('refuses anything that isn\'t strict JSON with an object at the top', () => {
    for (const text of ['', '﻿{}', '{"a": 1,}', '{"a": 1} // no', "{'a': 1}", '{"a": 01}', '{"a": NaN}', '[]', '"x"', '1', 'null', '{"a": "\t"}', '{} {}']) {
      expect(() => scan(text), JSON.stringify(text)).toThrowError(JsonTextError);
      try {
        scan(text);
      } catch (e) {
        expect((e as JsonTextError).why).toBe('not_json');
      }
    }
  });

  it('agrees with JSON.parse on every value it gives a span for (generated files)', () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    const ws = () => pick(['', ' ', '\n', '\r\n', '\t', '  \n  ']);
    const str = () => JSON.stringify(pick(['', 'a', 'é', '"q"', '\\', '}', '{[', 'x y', '\u0000'])).replace('\\u0000', pick(['\\u0000', '\\u0000']));
    const value = (depth: number): string => {
      const k = depth > 3 ? pick(['n', 's', 'l']) : pick(['n', 's', 'l', 'o', 'a']);
      if (k === 'n') return pick(['0', '-1', '1.0', '1e5', '12345678901234567890', '-0.5E-3']);
      if (k === 's') return str();
      if (k === 'l') return pick(['true', 'false', 'null']);
      const n = Math.floor(rand() * 4);
      const parts = Array.from({ length: n }, (_, i) => (k === 'o' ? `${ws()}${JSON.stringify(pick(['a', 'b', 'hooks', `k${i}`]) + i)}${ws()}:${ws()}${value(depth + 1)}${ws()}` : `${ws()}${value(depth + 1)}${ws()}`));
      return k === 'o' ? `{${parts.join(',') || ws()}}` : `[${parts.join(',') || ws()}]`;
    };
    for (let c = 0; c < 200; c++) {
      const keys = ['a', 'mcpServers', 'hooks', 'permissions'].filter(() => rand() < 0.7);
      const text = `${ws()}{${keys.map((k) => `${ws()}"${k}"${ws()}:${ws()}${k === 'a' ? value(0) : `{${ws()}}`}${ws()}`).join(',')}}${ws()}`;
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const root = scan(text);
      for (const k of keys) expect(JSON.parse(slice(text, member(root, k)!.value))).toEqual(parsed[k]);
    }
  });
});
