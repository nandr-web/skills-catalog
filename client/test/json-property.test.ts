// The splicer under generated files (golden setup.yaml property: its seeds and case count): each edit setup makes (its MCP
// entry, its hook group, its allow rules, each container made when it's absent) changes nothing but setup's own entries,
// and taking them out again, last first, gives back the input byte for byte. Files have random nesting (up to 64 deep),
// numbers (exponents, -0, past 2^53), escapes (\u, surrogate pairs), whitespace (tabs, CRLF, none), and each container
// present, empty, on one line, or absent.
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { appendItem, insertMember, removeItem, removeMember, type Spliced } from '../src/machine/json-splice.ts';
import { scanJson, type JsonContainer, type JsonNode } from '../src/machine/json-text.ts';

const property = loadGolden('setup.yaml').setup.property as { seeds: number[]; cases: number };
const ENTRY = { type: 'stdio', command: '/opt/node', args: ['/opt/cli.ts', 'mcp'], env: { SKILLS_SETUP_ID: '0'.repeat(32), SKILLS_HOME: '/h' } };
const GROUP = { hooks: [{ type: 'command', command: "SKILLS_HOME='/h' '/opt/node' '/opt/cli.ts' hook session-start --setup-id x 2>/dev/null || true", timeout: 10 }] };
const RULES = ['mcp__skills-catalog__search_shared_skills', 'mcp__skills-catalog__install_shared_skill', 'Bash(skills-catalog update)'];

function generator(seed: number) {
  let s = seed;
  const rand = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const style = pick([
    { eol: '\n', step: '  ' },
    { eol: '\r\n', step: '\t' },
    { eol: '\n', step: '    ' },
    { eol: '', step: '' },
  ]);
  const NUMBERS = ['0', '-0', '1.0', '1e5', '-1.5E-3', '9007199254740993', '12345678901234567890'];
  const STRINGS = ['""', '"é"', '"\\u00e9"', '"\\ud83d\\ude00"', '"a\\"b"', '"\\\\"', '"}{]["', '"\\n\\t"'];
  const line = (depth: number) => (style.eol ? style.eol + style.step.repeat(depth) : '');
  const value = (depth: number): string => {
    const r = rand();
    if (depth >= 64 || r < 0.45) return pick([...NUMBERS, ...STRINGS, 'true', 'false', 'null']);
    // A chain of single-item arrays sometimes, so some files nest deep.
    if (r < 0.5) return `[${value(depth + 1)}]`;
    const n = Math.floor(rand() * 3);
    if (rand() < 0.5) {
      const members = Array.from({ length: n }, (_, i) => `${line(depth + 1)}${pick(STRINGS.slice(0, 3)).replace(/"$/, `${i}"`)}: ${value(depth + 1)}`);
      return n ? `{${members.join(',')}${line(depth)}}` : '{}';
    }
    const items = Array.from({ length: n }, () => `${line(depth + 1)}${value(depth + 1)}`);
    return n ? `[${items.join(',')}${line(depth)}]` : '[]';
  };
  // A container setup edits: absent, empty, on one line, or with the person's own entries on their own lines.
  const container = (depth: number, open: string, close: string, inner: () => string): string | undefined => {
    const how = pick(['absent', 'empty', 'one line', 'lines']);
    if (how === 'absent') return undefined;
    if (how === 'empty') return `${open}${pick(['', ' ', line(depth)])}${close}`;
    if (how === 'one line') return `${open}${inner()}${close}`;
    return `${open}${line(depth + 1)}${inner()}${line(depth)}${close}`;
  };
  const object = (members: [string, string | undefined][], depth: number) => {
    const kept = members.filter(([, v]) => v !== undefined);
    return kept.length ? `{${kept.map(([k, v]) => `${line(depth + 1)}"${k}": ${v}`).join(',')}${line(depth)}}` : '{}';
  };
  const claude = () =>
    object(
      [
        ['numStartups', pick(NUMBERS)],
        ['deep', value(1)],
        ['mcpServers', container(1, '{', '}', () => `"other": ${value(2)}`)],
      ],
      0,
    );
  const settings = () =>
    object(
      [
        ['model', pick(STRINGS)],
        ['hooks', rand() < 0.25 ? undefined : object([['SessionStart', container(2, '[', ']', () => `{"matcher": "startup", "hooks": []}`)], ['Stop', value(2)]], 1)],
        ['permissions', rand() < 0.25 ? undefined : object([['allow', container(2, '[', ']', () => '"Bash(git *)"')], ['deny', '[]']], 1)],
      ],
      0,
    );
  const withEnd = (t: string) => t + pick(['', style.eol || '\n']);
  return { claude: () => withEnd(claude()), settings: () => withEnd(settings()) };
}

const all = () => true;
const at = (text: string, ...keys: string[]): JsonNode | undefined => {
  let n: JsonNode | undefined = scanJson(text, all);
  for (const k of keys) n = n?.kind === 'object' ? n.members.find((m) => m.key === k)?.value : undefined;
  return n;
};
const box = (n: JsonNode | undefined): JsonContainer => {
  if (!n || (n.kind !== 'object' && n.kind !== 'array')) throw new Error('not a container');
  return n;
};

// Setup's edit of one container: `value` (a member's) or `items` (appended), made in the deepest container present,
// the missing ones made with it. Returns how to undo it, last edit first.
type Undo = (text: string) => string;
function edit(text: string, path: string[], add: { key: string; value: unknown } | { items: unknown[] }): { text: string; undo: Undo[] } {
  const undo: Undo[] = [];
  let depth = path.length;
  while (depth > 0 && !at(text, ...path.slice(0, depth))) depth--;
  if (depth < path.length) {
    // Made from the first missing container down, holding everything below it.
    let v: unknown = 'key' in add ? { [add.key]: add.value } : add.items;
    for (let i = path.length - 1; i > depth; i--) v = { [path[i]!]: v };
    const parent = path.slice(0, depth);
    const r = insertMember(text, box(at(text, ...parent)), path[depth]!, v);
    undo.unshift((t) => removeMember(t, box(at(t, ...parent)), path[depth]!, r.interior));
    return { text: r.text, undo };
  }
  let t = text;
  if ('key' in add) {
    const r = insertMember(t, box(at(t, ...path)), add.key, add.value);
    undo.unshift((u) => removeMember(u, box(at(u, ...path)), add.key, r.interior));
    return { text: r.text, undo };
  }
  for (const item of add.items) {
    const r: Spliced = appendItem(t, box(at(t, ...path)), item);
    t = r.text;
    undo.unshift((u) => {
      const c = box(at(u, ...path));
      return removeItem(u, c, c.kind === 'array' ? c.items.length - 1 : 0, r.interior);
    });
  }
  return { text: t, undo };
}

describe('the splicer under generated files (golden setup.yaml property)', () => {
  it(`${property.cases} cases from the golden's seeds: only setup's entries change, and undoing them gives the input back`, () => {
    const per = Math.ceil(property.cases / property.seeds.length);
    let ran = 0;
    for (const seed of property.seeds) {
      const g = generator(seed);
      for (let c = 0; c < per && ran < property.cases; c++, ran++) {
        const claude = g.claude();
        const one = edit(claude, ['mcpServers'], { key: 'skills-catalog', value: ENTRY });
        const parsed = JSON.parse(one.text);
        expect(parsed.mcpServers['skills-catalog']).toEqual(ENTRY);
        delete parsed.mcpServers['skills-catalog'];
        const before = JSON.parse(claude);
        expect(parsed).toEqual(before.mcpServers ? before : { ...before, mcpServers: {} });
        expect(one.undo.reduce((t, u) => u(t), one.text), `seed ${seed} case ${c}`).toBe(claude);

        const settings = g.settings();
        const hooks = edit(settings, ['hooks', 'SessionStart'], { items: [GROUP] });
        const rules = edit(hooks.text, ['permissions', 'allow'], { items: RULES });
        expect(JSON.parse(rules.text).hooks.SessionStart.at(-1)).toEqual(GROUP);
        expect(JSON.parse(rules.text).permissions.allow.slice(-RULES.length)).toEqual(RULES);
        const back = [...rules.undo, ...hooks.undo].reduce((t, u) => u(t), rules.text);
        expect(back, `seed ${seed} case ${c}`).toBe(settings);
      }
    }
    expect(ran).toBe(property.cases);
  });
});
