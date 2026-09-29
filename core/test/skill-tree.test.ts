// The shared skill-tree module against the goldens: the fingerprint recipe (contract §4.3), SKILL.md and path rules
// (§4.1, §4.2), and diffs with their risk flags (§5.3, golden/histories.yaml).

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CatalogError } from '../src/errors.ts';
import {
  checkManifest,
  checkName,
  checkTree,
  diffTrees,
  entryOf,
  scanSecrets,
  fingerprint,
  unifiedDiff,
  type TreeFile,
  nameProblem,
  foldKey,
  flagText,
  checkFetched,
  RESERVED_NAMES_FILE,
  CASE_FOLDING_FILE,
} from '../src/skill-tree/index.ts';
import { GOLDEN, catalogNameOf, filesOf, generated, historyVersion, loadGolden, rawFilesOf, type RawFile } from './golden.ts';
import { expectLinear, times } from './linear.ts';

const skills = loadGolden('skills.yaml');
const histories = loadGolden('histories.yaml');

// The test's own fingerprint, written from the contract's recipe, never from the module's code.
function ownFingerprint(files: RawFile[]): string {
  const rows = files
    .map((f) => ({ p: Buffer.from(f.path.normalize('NFC'), 'utf8'), line: `${f.mode} ${createHash('sha256').update(f.bytes).digest('hex')} ${f.path.normalize('NFC')}\n` }))
    .sort((a, b) => Buffer.compare(a.p, b.p));
  return 'sha256:' + createHash('sha256').update(rows.map((r) => r.line).join('')).digest('hex');
}

function tree(files: RawFile[]): TreeFile[] {
  return checkTree(files);
}

function errorOf(fn: () => unknown): CatalogError {
  try {
    fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('expected a CatalogError');
}

function validate(name: string, files: RawFile[]) {
  const t = checkTree(files);
  checkManifest(t, name);
  return t;
}

describe('fingerprint (contract §4.3)', () => {
  it('matches coreutils on a listing written by hand', () => {
    const files = historyVersion(histories.versions['prc.v3']);
    const listing = [...files]
      .sort((a, b) => (a.path < b.path ? -1 : 1)) // ASCII paths: sorting strings is sorting bytes
      .map((f) => `${f.mode} ${createHash('sha256').update(f.bytes).digest('hex')} ${f.path}\n`)
      .join('');
    const shasum = spawnSync('shasum', ['-a', '256'], { input: listing, encoding: 'utf8' });
    expect(shasum.status).toBe(0);
    expect(fingerprint(tree(files).map(entryOf))).toBe('sha256:' + shasum.stdout.split(' ')[0]);
  });

  it('equals the test\'s own recipe for every valid fixture', () => {
    for (const [key, fx] of Object.entries<any>(skills.valid)) {
      const files = fx.generate ? generated(key) : filesOf(fx.files)!;
      expect(fingerprint(tree(files).map(entryOf)), key).toBe(ownFingerprint(files));
    }
  });

  it('changes with the mode, and sorts bytewise (uppercase before lowercase)', () => {
    const a: RawFile[] = [{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from('x') }, { path: 'run.sh', mode: '0644', bytes: Buffer.from('y') }];
    const b = a.map((f) => (f.path === 'run.sh' ? { ...f, mode: '0755' } : f));
    expect(fingerprint(tree(a).map(entryOf))).not.toBe(fingerprint(tree(b).map(entryOf)));
    expect(tree([{ path: 'b.md', mode: '0644', bytes: Buffer.from('') }, { path: 'Z.md', mode: '0644', bytes: Buffer.from('') }]).map((f) => f.path)).toEqual(['Z.md', 'b.md']);
  });

  it('stores paths in NFC, so NFD and NFC spellings of one tree have one fingerprint', () => {
    const nfd: RawFile[] = [{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from('x') }, { path: 'notas/cafe\u0301.md', mode: '0644', bytes: Buffer.from('olá\n') }];
    const nfc = nfd.map((f) => ({ ...f, path: f.path.normalize('NFC') }));
    expect(tree(nfd).map((f) => f.path)).toContain('notas/café.md');
    expect(fingerprint(tree(nfd).map(entryOf))).toBe(fingerprint(tree(nfc).map(entryOf)));
  });
});

describe('valid skills pass (golden/skills.yaml valid)', () => {
  for (const [key, fx] of Object.entries<any>(skills.valid)) {
    it(key, () => {
      const files = fx.generate ? generated(key) : filesOf(fx.files)!;
      const t = validate(catalogNameOf(key, fx, files), files);
      expect(t.length).toBe(files.length);
    });
  }
});

describe('invalid skills are refused with the golden error (golden/skills.yaml invalid)', () => {
  for (const [key, fx] of Object.entries<any>(skills.invalid)) {
    it(`${key} → ${fx.error}`, () => {
      const files = fx.generate ? generated(key) : fx.raw_files ? rawFilesOf(fx.raw_files) : filesOf(fx.files)!;
      const e = errorOf(() => validate(catalogNameOf(key, fx, files), files));
      expect(e.code).toBe(fx.error);
      if (fx.fields) expect(e.data['fields']).toEqual(fx.fields);
      if (fx.limit) expect(e.data['limit']).toBe(fx.limit);
    });
  }
});

describe('hostile file lists are refused (golden/skills.yaml hostile, the raw requests)', () => {
  for (const [key, fx] of Object.entries<any>(skills.hostile)) {
    if (!fx.raw_files || !fx.error) continue;
    it(`${key} → ${fx.error}`, () => {
      const files = rawFilesOf(fx.raw_files.map((f: any) => ({ ...f, path: String(f.path).replace('$RUN', '/sandbox') })));
      expect(errorOf(() => validate(catalogNameOf(key, fx, files), files)).code).toBe(fx.error);
    });
  }

  it('two paths one case-insensitive file system would store as one file are refused (Unicode case folding)', () => {
    const md = { path: 'SKILL.md', mode: '0644', bytes: Buffer.from('---\nname: x\ndescription: y\n---\nz\n') };
    const pairs = [
      ['SKILL.md', 'ſKILL.md'],
      ['aς.md', 'aσ.md'],
      ['straße.md', 'strasse.md'],
      ['ẞ.md', 'ss.md'], // capital sharp s: toUpperCase and toLowerCase alone never reach "ss"
      ['ẞ.md', 'ß.md'],
      ['ﬁle.md', 'file.md'],
      ['Key.md', 'key.md'], // the Kelvin sign
      ['Notes.md', 'notes.md'],
    ];
    for (const [a, b] of pairs) {
      const files = a === 'SKILL.md' ? [md, { path: b!, mode: '0644', bytes: Buffer.from('evil') }] : [md, { path: a!, mode: '0644', bytes: Buffer.from('1') }, { path: b!, mode: '0644', bytes: Buffer.from('2') }];
      expect(errorOf(() => checkTree(files)).code, `${a} / ${b}`).toBe('invalid_path');
    }
  });

  it('the fold is full Unicode case folding, over every code point', () => {
    // Idempotent everywhere; a character, its upper case and its lower case fold alike, except the one character
    // Unicode's full folding treats specially (dotless ı, whose upper case is I). The comparison uses the runtime's own
    // case tables. When the runtime's Unicode is the table's, every assigned code point is compared. When it isn't
    // (Node's ICU moves on its own schedule, per build), a code point the table knows nothing about (neither it nor its
    // runtime upper or lower case is in the table) is a letter of the other Unicode version and is skipped; a misfold
    // of any letter the table does know still fails.
    const table = readFileSync(CASE_FOLDING_FILE, 'utf8');
    const tableUnicode = /^# Unicode (\d+\.\d+)\./m.exec(table)?.[1];
    expect(tableUnicode).toMatch(/^\d+\.\d+$/);
    const sameUnicode = process.versions.unicode === tableUnicode;
    const known = new Set<number>();
    for (const line of table.split('\n')) {
      if (line === '' || line.startsWith('#')) continue;
      for (const h of line.split(' ')) known.add(parseInt(h, 16));
    }
    const inTable = (s: string) => [...s].some((ch) => known.has(ch.codePointAt(0)!));
    const differs: number[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
      if (/\p{Cn}/u.test(c)) continue;
      if (!sameUnicode && !inTable(c) && !inTable(c.toUpperCase()) && !inTable(c.toLowerCase())) continue;
      const f = foldKey(c);
      if (foldKey(f) !== f || foldKey(c.toUpperCase()) !== f || foldKey(c.toLowerCase()) !== f) differs.push(cp);
    }
    expect(differs).toEqual([0x131]);
  });

  it('more path shapes: empty segments, ".", backslashes, control characters, a file that is also a folder', () => {
    const md = { path: 'SKILL.md', mode: '0644', bytes: Buffer.from('---\nname: x\ndescription: y\n---\nz\n') };
    const cases: [string, string][] = [
      ['a//b.md', 'empty_segment'],
      ['./a.md', 'dot_segment'],
      ['a/./b.md', 'dot_segment'],
      ['a\\b.md', 'backslash'],
      ['a\u0000.md', 'control_character'],
      ['C:/x.md', 'absolute'],
      ['', 'empty'],
      ['a/', 'empty_segment'],
      ['read\u202eme.md', 'invisible_character'],
      ['a\u200b.md', 'invisible_character'],
      ['.git/config', 'git_folder'],
      ['x/.GIT/hooks/pre-commit', 'git_folder'],
      ['.claude/settings.json', 'claude_folder'],
      ['docs/.CLAUDE/agents/x.md', 'claude_folder'],
      ['.claude-plugin/plugin.json', 'plugin_folder'],
      ['x/.Claude-Plugin/plugin.json', 'plugin_folder'],
      // a file an assistant reads as a project's own instructions, at any depth, as a folder too, with the same fold
      ['CLAUDE.md', 'memory_file'],
      ['docs/agents.md', 'memory_file'],
      ['a/b/Claude.Local.MD', 'memory_file'],
      ['CLAUDE.md/x.md', 'memory_file'],
      ['ＣＬＡＵＤＥ.md', 'memory_file'],
      ['ſkills/AGENTS.md', 'memory_file'],
      [`${'a'.repeat(256)}.md`, 'segment_too_long'],
      // the wider invisible set: no-break, ideographic and other spaces, U+2800, variation selectors, fillers, private use
      ['a b.md', 'invisible_character'],
      ['a　b.md', 'invisible_character'],
      ['a⠀b.md', 'invisible_character'],
      ['a️b.md', 'invisible_character'],
      ['aᅟb.md', 'invisible_character'],
      ['ab.md', 'invisible_character'],
      ['a b.md', 'invisible_character'],
      // not portable: Windows' reserved characters, a trailing dot or space, device names in any case
      ['a<b.md', 'not_portable'],
      ['ab:c.md', 'not_portable'],
      ['a:b.md', 'not_portable'], // no drive letter without a slash
      ['a"b.md', 'not_portable'],
      ['a|b.md', 'not_portable'],
      ['a?.md', 'not_portable'],
      ['a*.md', 'not_portable'],
      ['notes./x.md', 'not_portable'],
      ['notes /x.md', 'not_portable'],
      ['nul.md', 'not_portable'],
      ['NUL', 'not_portable'],
      ['docs/Com1.txt', 'not_portable'],
      ['COM¹.md', 'not_portable'],
      ['lpt0', 'not_portable'],
      ['.git.', 'not_portable'],
      ['.git::$INDEX_ALLOCATION', 'not_portable'],
      // the order is pinned (contract §4.2): text rules before segment rules; per segment, folders before portability
      // before length; the whole path's length after the segments
      ['a​/.git/x.md', 'invisible_character'],
      ['.git/a:b.md', 'git_folder'],
      ['AGENTS.md/a:b.md', 'memory_file'],
      [`ab:c/${'a'.repeat(256)}`, 'not_portable'],
      [Array.from({ length: 9 }, () => 'a'.repeat(120)).join('/'), 'too_long'],
    ];
    for (const [path, why] of cases) {
      const e = errorOf(() => checkTree([md, { path, mode: '0644', bytes: Buffer.from('') }]));
      expect([e.code, e.data['why']], JSON.stringify(path)).toEqual(['invalid_path', why]);
    }
    expect(checkTree([md, { path: `${'a'.repeat(252)}.md`, mode: '0644', bytes: Buffer.from('') }])).toHaveLength(2);
    for (const path of ['CLAUDE.md.bak', 'my-agents.md', 'docs/claude.mdx', 'agents/notes.md']) expect(checkTree([md, { path, mode: '0644', bytes: Buffer.from('') }]), path).toHaveLength(2);
    expect(errorOf(() => checkTree([md, { path: 'a', mode: '0644', bytes: Buffer.from('') }, { path: 'a/b.md', mode: '0644', bytes: Buffer.from('') }])).code).toBe('invalid_path');
  });
});

describe('front matter is a safe subset of YAML with plain keys (contract §4.1)', () => {
  const skill = (fm: string) => [{ path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from(`---\n${fm}---\nBody.\n`) }];
  const problem = (fm: string) => {
    const e = errorOf(() => checkManifest(skill(fm), 'x'));
    return [e.data['problem'], e.data['feature'] ?? e.data['fields']];
  };

  it('refuses a merge key, at the top or at any depth, that would hide a tool grant or hooks', () => {
    expect(problem('name: x\ndescription: y\n<<: {allowed-tools: Bash}\n')).toEqual(['yaml_feature', 'merge_key']);
    expect(problem('name: x\ndescription: y\n<<:\n  hooks: {PreToolUse: ./x.sh}\n')).toEqual(['yaml_feature', 'merge_key']);
    expect(problem('name: x\ndescription: y\nmetadata:\n  a:\n    <<: {allowed-tools: Bash}\n')).toEqual(['yaml_feature', 'merge_key']);
  });

  it('refuses anchors, aliases, explicit tags, duplicate keys and a second document', () => {
    expect(problem('name: &n x\ndescription: y\n')).toEqual(['yaml_feature', 'anchor']);
    expect(problem('name: x\ndescription: y\nmetadata: {a: *n}\n')).toEqual(['yaml_feature', 'alias']);
    expect(problem('name: !!str x\ndescription: y\n')).toEqual(['yaml_feature', 'tag']);
    expect(problem('name: x\ndescription: !custom y\n')).toEqual(['yaml_feature', 'tag']);
    expect(problem('name: x\nname: x\ndescription: y\n')).toEqual(['yaml_feature', 'duplicate_key']);
    expect(problem('name: x\ndescription: y\n...\nname: z\n')).toEqual(['yaml_feature', 'multiple_documents']); // a document end, then a second one
  });

  it('refuses a top-level key that isn\'t plain: a hidden character, a BOM, a bidi override, capitals, a quoted <<', () => {
    expect(problem('name: x\ndescription: y\nallowed\u200b-tools: Bash\n')).toEqual(['key_format', ['allowed\u200b-tools']]);
    expect(problem('name: x\ndescription: y\n\ufeffhooks: z\n')).toEqual(['key_format', ['\ufeffhooks']]);
    expect(problem('name: x\ndescription: y\nallowed-tools\u202e: z\n')).toEqual(['key_format', ['allowed-tools\u202e']]);
    expect(problem('name: x\ndescription: y\nAllowed-Tools: Bash\n')).toEqual(['key_format', ['Allowed-Tools']]);
    expect(problem('name: x\ndescription: y\n"<<": {allowed-tools: Bash}\n')).toEqual(['key_format', ['<<']]);
  });

  it('keeps plain keys, nested maps and lists as they are', () => {
    const m = checkManifest(skill('name: x\ndescription: y\nallowed-tools: [Read, Grep]\nmetadata: {tags: docs, owner_team: a}\n'), 'x');
    expect(m.frontmatter).toEqual({ name: 'x', description: 'y', 'allowed-tools': ['Read', 'Grep'], metadata: { tags: 'docs', owner_team: 'a' } });
  });
});

describe('names (golden/skills.yaml missing-names, the name rules)', () => {
  it('refuses uppercase and empty names', () => {
    for (const m of skills['missing-names'].filter((x: any) => x.error === 'invalid_name')) {
      expect(errorOf(() => checkName(m.name)).code, m.name).toBe('invalid_name');
    }
    expect(checkName('release-note-draft')).toBe('release-note-draft');
  });

  it('refuses the reserved names (the config list: bundled skills, built-in commands, aliases, the companion skill)', () => {
    const names = readFileSync(RESERVED_NAMES_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    expect(names).toHaveLength(136);
    for (const name of ['code-review', 'debug', 'doctor', 'skills-catalog', 'shared-skills', 'allowed-tools', 'synced', 'anthropic-skills', 'release-notes', names.at(-1)!]) {
      const e = errorOf(() => checkName(name));
      expect([e.code, e.data['why']], name).toEqual(['invalid_name', 'reserved']);
    }
    expect(nameProblem('code-review', new Set())).toBeNull(); // the list is config
    expect(checkName('code-review-checklist')).toBe('code-review-checklist');
  });
});

describe('the gate pairs the core\'s diff decides now (golden/histories.yaml gate; the rest come with the update gate)', () => {
  // The kinds this diff computes today; pairs that expect runs_at_load, instructions_changed or a command position's
  // runnable_file are the update gate's (the next slice), in the same shared module.
  const NOW = new Set(['capability_frontmatter', 'new_publisher']);
  const side = (key: string | null) => (key === null ? null : { files: tree(historyVersion(histories.versions[key])), publisher: 'ana' });
  const pairs = (histories.histories.gate.pairs as any[]).filter((p) => p.risk_flags.every((f: any) => NOW.has(f.kind)));

  it.each(pairs.map((p) => [`${p.from} → ${p.to}`, p] as const))('%s', (_label, p) => {
    const got = diffTrees(side(p.from), side(p.to)!).risk_flags;
    const project = (flags: any[], keys: (f: any) => string[]) => flags.map((f) => JSON.stringify(Object.fromEntries(keys(f).map((k) => [k, f[k] ?? null])))).sort();
    expect(project(got, (_f) => ['kind', 'path']), p.note).toEqual(project(p.risk_flags, (_f) => ['kind', 'path']));
    for (const want of p.risk_flags) {
      const match = got.find((f) => f.kind === want.kind && f.path === want.path && (want.field === undefined || f.field === want.field))!;
      for (const k of ['line', 'field', 'from', 'to'] as const) if (k in want) expect(match[k] ?? null, `${p.to} ${k}`).toEqual(want[k]);
    }
    if (p.detail_text) {
      const detail = [...got[0]!.detail];
      expect(got[0]!.detail.startsWith(p.detail_text.starts_with)).toBe(true);
      expect(detail).toHaveLength(p.detail_text.code_points);
      expect(detail.at(-1)).toBe(p.detail_text.ends_with);
    }
  });

  it('covers every safe-list pair (the list is at least what these goldens name)', () => {
    expect(pairs.length).toBeGreaterThanOrEqual(9);
  });
});

describe('flag text is plain: invisible characters escaped, then cut to 200 code points ending in … (contract §5.3)', () => {
  it('escapes, then cuts, and leaves short visible text alone', () => {
    expect(flagText('allowed-tools added: Bash')).toBe('allowed-tools added: Bash');
    expect(flagText('a\u{200b}b\u{202e}c')).toBe('a\\u{200b}b\\u{202e}c');
    const long = flagText(`\u{200b}${'a'.repeat(300)}`);
    expect([...long]).toHaveLength(200);
    expect(long.startsWith('\\u{200b}aaa')).toBe(true);
    expect(long.endsWith('a…')).toBe(true);
    expect([...flagText('b'.repeat(200))]).toHaveLength(200);
    expect(flagText('b'.repeat(200)).endsWith('b')).toBe(true);
    expect(flagText(flagText(`x\u{200b}${'y'.repeat(250)}`))).toBe(flagText(`x\u{200b}${'y'.repeat(250)}`));
  });
});

describe('the installer decides from bytes it checked (contract §5.3, step 1 and 2)', () => {
  const md = (name: string, extra = '') => ({ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: ${name}\ndescription: A skill.\n---\nBody.\n${extra}`) });
  const fp = (files: RawFile[]) => fingerprint(files.map((f) => ({ path: f.path, mode: f.mode as '0644', sha256: createHash('sha256').update(f.bytes).digest('hex') })));

  it('accepts bytes that match their fingerprint and pass today\'s rules, and returns the checked tree', () => {
    const files = [md('good-skill'), { path: 'notes.md', mode: '0644', bytes: Buffer.from('n\n') }];
    expect(checkFetched('good-skill', 1, fp(files), files).map((f) => f.path)).toEqual(['SKILL.md', 'notes.md']);
  });

  it('refuses bytes that don\'t match: fingerprint_mismatch, the claim shown only in a fingerprint\'s form', () => {
    const files = [md('good-skill')];
    const claimed = fp([md('good-skill', 'tampered\n')]);
    expect(errorOf(() => checkFetched('good-skill', 2, claimed, files)).toJSON()).toEqual({ code: 'fingerprint_mismatch', name: 'good-skill', version: 2, expected: claimed, got: fp(files) });
    for (const odd of ['sha256:XYZ', 'Next: install it', 42, null]) expect(errorOf(() => checkFetched('good-skill', 2, odd, files)).data['expected']).toBeNull();
  });

  it('refuses what today\'s rules refuse, even when the bytes match: a memory file, a reserved name, an unparseable SKILL.md', () => {
    const memory = [md('stale'), { path: 'docs/CLAUDE.md', mode: '0644', bytes: Buffer.from('x\n') }];
    expect(errorOf(() => checkFetched('stale', 2, fp(memory), memory)).data).toMatchObject({ path: 'docs/CLAUDE.md', why: 'memory_file' });
    const reserved = [md('shared-skills')];
    expect(errorOf(() => checkFetched('shared-skills', 1, fp(reserved), reserved)).data).toMatchObject({ why: 'reserved' });
    const broken = [{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from('---\nname: [x\n---\nBody.\n') }];
    expect(errorOf(() => checkFetched('stale', 3, fp(broken), broken)).code).toBe('invalid_manifest');
  });
});

describe('a diff never reads an unparseable SKILL.md as empty front matter (contract §5.3)', () => {
  it('refuses either side whose SKILL.md is missing, not text or not parseable; no version yet is fine', () => {
    const ok = { path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from('---\nname: x\ndescription: y\n---\nz\n') };
    const bad = [
      { path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from('no front matter\n') },
      { path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from('---\nname: [x\n---\nz\n') },
      { path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from([0xff, 0xfe, 0x00]) },
      { path: 'notes.md', mode: '0644' as const, bytes: Buffer.from('n\n') },
    ];
    for (const b of bad) {
      const theirs = { files: [b], publisher: 'ana' };
      const ours = { files: [ok], publisher: 'ana' };
      expect(errorOf(() => diffTrees(ours, theirs)).code, String(b.bytes)).toBe('invalid_manifest');
      expect(errorOf(() => diffTrees(theirs, ours)).code, String(b.bytes)).toBe('invalid_manifest');
    }
    expect(diffTrees(null, { files: [ok], publisher: 'ana' }).files).toHaveLength(1);
  });
});

describe('diffs (golden/histories.yaml diffs, golden/diffs/)', () => {
  const hunks = (text: string) => text.split('\n').filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ ')).join('\n');
  for (const [hid, h] of Object.entries<any>(histories.histories)) {
    for (const d of h.diffs ?? []) {
      it(`${hid} v${d.from} → v${d.to}`, () => {
        const prefix = hid;
        const vFrom = tree(historyVersion(histories.versions[`${prefix}.v${d.from}`]));
        const vTo = tree(historyVersion(histories.versions[`${prefix}.v${d.to}`]));
        const got = diffTrees({ files: vFrom, publisher: 'ana' }, { files: vTo, publisher: 'ana' });
        expect(got.files.map((f) => ({ path: f.path, status: f.status }))).toEqual(d.files.map((f: any) => ({ path: f.path, status: f.status })));
        for (const f of d.files) if (f.flags) expect(got.files.find((g) => g.path === f.path)!.flags).toMatchObject(f.flags);
        expect(got.risk_flags.map((r) => ({ kind: r.kind, path: r.path }))).toEqual(d.risk_flags);
        if (d.unified) {
          const want = readFileSync(join(GOLDEN, d.unified), 'utf8');
          expect(hunks(got.files.map((f) => f.unified ?? '').join(''))).toBe(hunks(want));
        }
        expect(got.publisher_changed).toBe(false);
      });
    }
  }

  it('flags a publisher change, a tool grant, and one reason per file', () => {
    const md = (extra = '') => ({ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: x\ndescription: y\n${extra}---\nz\n`) });
    const a = tree([md()]);
    const b = tree([md('allowed-tools: Bash\n'), { path: 'run.py', mode: '0755', bytes: Buffer.from('print(1)\n') }, { path: 'logo.png', mode: '0644', bytes: Buffer.from([0x89, 0x50, 0]) }]);
    const got = diffTrees({ files: a, publisher: 'alice' }, { files: b, publisher: 'bob' });
    // The new version grants (allowed-tools), so a new non-markdown file is instructions_changed, before non_markdown (§5.3).
    expect(got.risk_flags).toEqual([
      { kind: 'instructions_changed', path: 'logo.png', detail: 'pre-approves Bash' },
      { kind: 'runnable_file', path: 'run.py', detail: 'executable script' },
      { kind: 'capability_frontmatter', path: 'SKILL.md', line: 4, field: 'allowed-tools', from: null, to: 'Bash', detail: 'allowed-tools added: Bash' },
      { kind: 'new_publisher', from: 'alice', to: 'bob', detail: 'alice → bob' },
    ]);
    expect(got.frontmatter_changes).toEqual([{ field: 'allowed-tools', from: null, to: 'Bash' }]);
    expect(got.files.find((f) => f.path === 'logo.png')!.unified).toBeUndefined();
    // With no grant, the same file is non_markdown.
    const plain = diffTrees({ files: a, publisher: 'alice' }, { files: tree([md(), { path: 'logo.png', mode: '0644', bytes: Buffer.from([0x89, 0x50, 0]) }]), publisher: 'alice' });
    expect(plain.risk_flags).toEqual([{ kind: 'non_markdown', path: 'logo.png', detail: '.png file' }]);
  });

  it('flags a change to any front matter key not on the safe list, and none on it (the gate fails closed)', () => {
    const md = (extra = '') => ({ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: x\ndescription: y\n${extra}---\nz\n`) });
    const flagged = (before: string, after: string) =>
      diffTrees({ files: tree([md(before)]), publisher: 'a' }, { files: tree([md(after)]), publisher: 'a' })
        .risk_flags.filter((f) => f.kind === 'capability_frontmatter')
        .map((f) => f.field);
    expect(flagged('', 'context: fork\nagent: Explore\n')).toEqual(['agent', 'context']);
    expect(flagged('model: haiku\n', 'model: opus\n')).toEqual(['model']);
    expect(flagged('', 'some-key-claude-code-adds-later: true\n')).toEqual(['some-key-claude-code-adds-later']);
    expect(flagged('shell: bash\n', '')).toEqual(['shell']);
    expect(flagged('version: "1"\nlicense: MIT\n', 'version: "2"\nlicense: Apache-2.0\nwhen_to_use: always\nmetadata: {tags: docs}\n')).toEqual([]);
  });

  it('lets a config remove keys from the safe list, never add one (contract §5.3: fixed in code)', () => {
    const md = (extra = '') => ({ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: x\ndescription: y\n${extra}---\nz\n`) });
    const flagged = (before: string, after: string, keys: readonly string[]) =>
      diffTrees({ files: tree([md(before)]), publisher: 'a' }, { files: tree([md(after)]), publisher: 'a' }, keys)
        .risk_flags.map((f) => f.field);
    const DEFAULTS = ['name', 'description', 'when_to_use', 'argument-hint', 'arguments', 'license', 'compatibility', 'metadata', 'version', 'tags'];
    expect(flagged('', 'allowed-tools: Bash\nhooks: {Stop: ./x.sh}\n', [...DEFAULTS, 'allowed-tools', 'hooks'])).toEqual(['allowed-tools', 'hooks']);
    expect(flagged('license: MIT\n', 'license: Apache-2.0\n', DEFAULTS.filter((k) => k !== 'license'))).toEqual(['license']);
    expect(flagged('license: MIT\n', 'license: Apache-2.0\n', DEFAULTS)).toEqual([]);
  });

  it('treats hooks in the front matter as a capability, like a tool grant', () => {
    const md = (extra = '') => ({ path: 'SKILL.md', mode: '0644', bytes: Buffer.from(`---\nname: x\ndescription: y\n${extra}---\nz\n`) });
    const got = diffTrees({ files: tree([md()]), publisher: 'a' }, { files: tree([md('hooks:\n  PreToolUse: ./check.sh\n')]), publisher: 'a' });
    expect(got.risk_flags).toMatchObject([{ kind: 'capability_frontmatter', field: 'hooks', from: null, to: { PreToolUse: './check.sh' } }]);
  });

  it('writes git-style hunks, including a missing final newline', () => {
    expect(unifiedDiff('a\nb\n', 'a\nc', 'f.md')).toBe('--- a/f.md\n+++ b/f.md\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n\\ No newline at end of file\n');
    expect(unifiedDiff(null, 'x\n', 'n.md')).toBe('--- /dev/null\n+++ b/n.md\n@@ -0,0 +1 @@\n+x\n');
    const long = Array.from({ length: 20 }, (_, i) => `l${i}\n`);
    const changed = [...long];
    changed[2] = 'X\n';
    changed[17] = 'Y\n';
    const out = unifiedDiff(long.join(''), changed.join(''), 'f.md');
    expect(out.match(/^@@/gm)).toHaveLength(2);
  });
});

// The secret scan (contract §2, §5.1 step 1): a secret's shape wherever it sits, including after an underscore in a
// variable's name or inside JSON's quotes, and never a word in prose.
describe('the secret scan finds a secret by its shape, in any variable name or quoting', () => {
  const scan = (line: string) => scanSecrets([{ path: 'config.sh', mode: '0644', bytes: Buffer.from(`# settings\n${line}\n`) }]);
  const flagged: [string, string][] = [
    // 40 characters with slashes, like an AWS secret key; joined, since a real-looking key in a public repo trips GitHub's
    // push protection
    [['AWS_SECRET_ACCESS_KEY=', 'QAFAKE000/QAFAKE000/', 'QAFAKE0000QAFAKE0000'].join(''), 'password_or_token'],
    ['export DB_PASSWORD=correct-horse-battery', 'password_or_token'],
    ['STRIPE_API_KEY=0123456789abcdefghij', 'password_or_token'],
    ['{"password": "correct-horse-battery"}', 'password_or_token'],
    ["  'auth_token': 'abcdefghijklmnop',", 'password_or_token'],
    ['password: correct-horse-battery', 'password_or_token'],
    ['apiKey=0123456789abcdefghij', 'password_or_token'],
    // the key is a run of letters, digits, _ - . that ends in one of the words (contract §2)
    ['MYPASSWORD=correct-horse-battery', 'password_or_token'],
    ['client_secret: abcdefghijklmnopqrst', 'password_or_token'],
    ['OPENAI_SECRET_KEY = "abcdefghijklmnopqrst"', 'password_or_token'],
    ['service.private-key=abcdefghijklmnopqrst', 'password_or_token'],
    // the word as a whole part anywhere, spaces inside the words, :=, => and --flags, any value that isn't a space or quote
    ['SECRET_KEY_BASE=abcdefghijklmnopqrst', 'password_or_token'],
    ['DB_PASSWORD_PROD=correct-horse-battery', 'password_or_token'],
    ['"api key": "abcdefghijklmnopqrst"', 'password_or_token'],
    ['token := "abcdefghijklmnopqrst"', 'password_or_token'],
    [':password => "abcdefghijklmnopqrst"', 'password_or_token'],
    ['mysql --password s3cr3t-value-1234 -u root', 'password_or_token'],
    ['curl --auth-token=abcdefghijklmnopqrst https://example.com', 'password_or_token'],
    ['password=abc!def#ghi%jkl&', 'password_or_token'],
    // a JWT is a secret's value, never a dotted name (jwt.io's shape: its header, a sub, a 32-byte signature). Joined here,
    // since a real-looking token in a public repo trips GitHub's push protection.
    [['token = ', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', '.', 'eyJzdWIiOiJRQUZBS0UifQ', '.', 'QAFAKE0000QAFAKE0000QAFAKE0000QAFAKE0000QAF'].join(''), 'password_or_token'],
    // a reference is the whole value, never only its start (contract §2); the OAuth-shaped value is joined like the JWT
    [['token = ', 'ya29', '.a0AfH6SMBx3Qw9e8r7t6y5u4i3o2p1'].join(''), 'password_or_token'],
    ['password=Summer.Time2024!xyz', 'password_or_token'],
    ['password: $uperSecretPassw0rd', 'password_or_token'],
    ['password: <x>realsecretvalue123', 'password_or_token'],
    ['token = ${A}realsecretvalue123', 'password_or_token'],
    ['KEY_ID=prefix_AKIAIOSFODNN7EXAMPLE', 'aws_access_key'],
  ];
  for (const [line, kind] of flagged) {
    it(`flags ${line}`, () => expect(scan(line)).toEqual({ path: 'config.sh', line: 2, kind }));
  }
  const passed = [
    'passwords: must be at least twelve characters long',
    'tokenizer: sentencepiece-model-v2-large',
    'secretary=Jane_Doe_the_second_one',
    'password: ${DB_PASSWORD}',
    'echo "$API_TOKEN" > /dev/null',
    'The token comes from the environment, never from this file.',
    'TOKENS=abcdefghijklmnopqrst',
    'password_hint=the-name-of-my-first-dog',
    'DB_PASSWORD_FILE=/run/secrets/db_password',
    // a value that refers to a secret instead of holding one (contract §2)
    'const token = process.env.GITHUB_TOKEN;',
    'token = process.env["GITHUB_TOKEN"]',
    'secret = os.environ["APP_SECRET_VALUE"]',
    'secret = os.environ.get("APP_SECRET_VALUE")',
    'password = os.getenv("DB_PASSWORD_VALUE")',
    'API_TOKEN = ENV["API_TOKEN_VALUE"]',
    'String password = System.getenv("DB_PASSWORD");',
    'githubToken = self.tokenizer.encode(text)',
    'api_key: config.api_key_from_vault',
    'token = get_token_from_keychain()',
    'password: <your-password-here>',
    'token: $env:GITHUB_TOKEN_VALUE',
    'password: $DB_PASSWORD_VALUE',
    // the longest word wins, and the part after it decides (contract §2)
    'SECRET_KEY_FILE=/run/secrets/secret_key_base',
    'SECRET_KEY_PATH=/etc/app/secret_key_base.txt',
  ];
  for (const line of passed) {
    it(`leaves alone ${line}`, () => expect(scan(line)).toBeNull());
  }

  // The scan never backtracks badly: a line of a megabyte is scanned in well under a second, whatever it holds.
  // The time grows with the line, not faster (test/linear.ts), so a busy machine can't fail it and a backtracking
  // pattern still does.
  it('scans a megabyte-long line in linear time', () => {
    const cases: [string, (scale: number) => string][] = [
      ['password_ keys, then a value', (s) => times('password_', 110_000)(s) + '=' + 'x'.repeat(20)],
      ['a token prefix, then letters', (s) => 'ghp_' + times('a', 1_000_000)(s)],
      ['AKIA again and again', times('AKIA', 250_000)],
      ['YAML keys', times('a: ', 330_000)],
      ['equals signs', (s) => 'x'.repeat(200) + times('=', 1_000_000)(s)],
      ['k= again and again', times('k=', 500_000)],
      ['k: again and again', times('k:', 500_000)],
      ['password= again and again', times('password=', 110_000)],
    ];
    for (const [label, input] of cases) expectLinear(label, input, scan);
  }, 120_000);
});
