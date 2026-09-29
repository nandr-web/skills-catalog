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
  fingerprint,
  unifiedDiff,
  type TreeFile,
  nameProblem,
  foldKey,
  RESERVED_NAMES_FILE,
} from '../src/skill-tree/index.ts';
import { GOLDEN, catalogNameOf, filesOf, generated, historyVersion, loadGolden, rawFilesOf, type RawFile } from './golden.ts';

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
    // Unicode's full folding treats specially (dotless ı, whose upper case is I).
    const differs: number[] = [];
    for (let cp = 0; cp < 0x110000; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const c = String.fromCodePoint(cp);
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
      ['a:b.md', 'absolute'], // a drive letter, checked before any segment rule
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
      [`ab:c/${'a'.repeat(256)}`, 'not_portable'],
      [Array.from({ length: 9 }, () => 'a'.repeat(120)).join('/'), 'too_long'],
    ];
    for (const [path, why] of cases) {
      const e = errorOf(() => checkTree([md, { path, mode: '0644', bytes: Buffer.from('') }]));
      expect([e.code, e.data['why']], JSON.stringify(path)).toEqual(['invalid_path', why]);
    }
    expect(checkTree([md, { path: `${'a'.repeat(252)}.md`, mode: '0644', bytes: Buffer.from('') }])).toHaveLength(2);
    expect(errorOf(() => checkTree([md, { path: 'a', mode: '0644', bytes: Buffer.from('') }, { path: 'a/b.md', mode: '0644', bytes: Buffer.from('') }])).code).toBe('invalid_path');
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
    expect(names).toHaveLength(132);
    for (const name of ['code-review', 'debug', 'doctor', 'skills-catalog', names.at(-1)!]) {
      const e = errorOf(() => checkName(name));
      expect([e.code, e.data['why']], name).toEqual(['invalid_name', 'reserved']);
    }
    expect(nameProblem('code-review', new Set())).toBeNull(); // the list is config
    expect(checkName('code-review-checklist')).toBe('code-review-checklist');
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
    expect(got.risk_flags).toEqual([
      { kind: 'non_markdown', path: 'logo.png', detail: '.png file' },
      { kind: 'runnable_file', path: 'run.py', detail: 'executable script' },
      { kind: 'capability_frontmatter', path: 'SKILL.md', line: 4, field: 'allowed-tools', from: null, to: 'Bash', detail: 'allowed-tools added: Bash' },
      { kind: 'new_publisher', from: 'alice', to: 'bob', detail: 'alice → bob' },
    ]);
    expect(got.frontmatter_changes).toEqual([{ field: 'allowed-tools', from: null, to: 'Bash' }]);
    expect(got.files.find((f) => f.path === 'logo.png')!.unified).toBeUndefined();
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
