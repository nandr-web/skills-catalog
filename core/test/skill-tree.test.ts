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
    for (const [a, b] of [['SKILL.md', 'ſKILL.md'], ['aς.md', 'aσ.md'], ['straße.md', 'strasse.md'], ['ﬁle.md', 'file.md'], ['Notes.md', 'notes.md']]) {
      const files = a === 'SKILL.md' ? [md, { path: b!, mode: '0644', bytes: Buffer.from('evil') }] : [md, { path: a!, mode: '0644', bytes: Buffer.from('1') }, { path: b!, mode: '0644', bytes: Buffer.from('2') }];
      expect(errorOf(() => checkTree(files)).code, `${a} / ${b}`).toBe('invalid_path');
    }
  });

  it('more path shapes: empty segments, ".", backslashes, control characters, a file that is also a folder', () => {
    const md = { path: 'SKILL.md', mode: '0644', bytes: Buffer.from('---\nname: x\ndescription: y\n---\nz\n') };
    for (const path of ['a//b.md', './a.md', 'a/./b.md', 'a\\b.md', 'a\u0000.md', 'C:/x.md', '', 'a/']) {
      expect(errorOf(() => checkTree([md, { path, mode: '0644', bytes: Buffer.from('') }])).code, JSON.stringify(path)).toBe('invalid_path');
    }
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
