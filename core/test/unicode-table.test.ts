// One Unicode version for the path rules (contract §4.2): the invisible_character set comes from config/invisible-characters.txt,
// made for the case-folding table's version, so a path is accepted or refused the same on every runtime, whatever Unicode
// version it knows.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CASE_FOLDING_FILE, INVISIBLE, INVISIBLE_FILE, TABLE_UNICODE, checkTree, unicodeProblem } from '../src/skill-tree/index.ts';
import { CatalogError } from '../src/errors.ts';
import { onRunnerPath, processEnv } from './process-env.ts';
import { sandbox } from './sandbox.ts';

const core = join(import.meta.dirname, '..');
const versionOf = (file: string) => /^# Unicode (\d+\.\d+\.\d+),/m.exec(readFileSync(file, 'utf8'))?.[1];
const pathProblem = (path: string) => {
  try {
    checkTree([{ path: 'SKILL.md', mode: '0644', bytes: Buffer.from('---\nname: x\ndescription: y\n---\nBody.\n') }, { path, mode: '0644', bytes: Buffer.from('x\n') }]);
    return null;
  } catch (e) {
    return e instanceof CatalogError ? String(e.data['why'] ?? e.code) : String(e);
  }
};

describe('the invisible_character table', () => {
  it('is for the case-folding table\'s Unicode version', () => {
    expect(versionOf(INVISIBLE_FILE)).toBe('16.0.0');
    expect(versionOf(INVISIBLE_FILE)).toBe(versionOf(CASE_FOLDING_FILE));
  });

  it('refuses U+200B, U+2800, U+3164 and U+A7CE (a Unicode 17 letter), and accepts U+00E9 and U+4E00, on every runtime', () => {
    for (const cp of [0x200b, 0x2800, 0x3164, 0xa7ce]) expect(pathProblem(`a${String.fromCodePoint(cp)}b.md`), cp.toString(16)).toBe('invisible_character');
    for (const cp of [0xe9, 0x4e00]) expect(pathProblem(`a${String.fromCodePoint(cp)}b.md`), cp.toString(16)).toBeNull();
    for (const cp of [0x20, 0x41]) expect(INVISIBLE.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(false);
  });

  it('takes its default-ignorable code points from the extract, whose own total they match', () => {
    const extract = readFileSync(join(core, 'scripts', 'unicode', 'DerivedCoreProperties-16.0.0-Default_Ignorable_Code_Point.txt'), 'utf8');
    let count = 0;
    for (const m of extract.matchAll(/^([0-9A-F]{4,6})(?:\.\.([0-9A-F]{4,6}))?\s*; Default_Ignorable_Code_Point\b/gm)) {
      const from = parseInt(m[1]!, 16);
      const to = parseInt(m[2] ?? m[1]!, 16);
      count += to - from + 1;
      for (let cp = from; cp <= to; cp++) expect(INVISIBLE.test(String.fromCodePoint(cp)), cp.toString(16)).toBe(true);
    }
    expect(count).toBe(Number(/^# Total code points: (\d+)$/m.exec(extract)?.[1]));
    expect(count).toBe(4174);
  });

  // A fresh run needs a Python whose unicodedata is the table's version; with another, the script refuses to run.
  // The runner's own python3 (the system's is often older), started with a built environment.
  const python3 = onRunnerPath('python3') ?? 'python3';
  const python = spawnSync(python3, ['-c', 'import unicodedata; print(unicodedata.unidata_version)'], { env: processEnv(sandbox()), encoding: 'utf8' });
  it.skipIf(python.status !== 0 || python.stdout.trim() !== '16.0.0')('matches a fresh run of scripts/invisible-characters.py', () => {
    const r = spawnSync(python3, [join(core, 'scripts', 'invisible-characters.py'), '--check'], { env: processEnv(sandbox()), encoding: 'utf8' });
    expect([r.status, r.stderr]).toEqual([0, '']);
  });

  // Normalisation never changes an assigned character (Unicode's stability policy), so the runtime's normalize() is safe
  // only when every unassigned code point is refused first, on the path as given, and the runtime knows at least the
  // table's version (contract §4.2).
  it('refuses a hidden character on the path as given, before any normalisation', () => {
    // U+2002 is a space separator, which NFKC (in the case fold) would make a plain space
    const EN_SPACE = String.fromCodePoint(0x2002);
    expect(EN_SPACE.normalize('NFKC')).toBe(' ');
    expect(pathProblem(`a${EN_SPACE}b.md`)).toBe('invisible_character');
    const source = readFileSync(join(core, 'src', 'skill-tree', 'tree.ts'), 'utf8');
    const body = source.slice(source.indexOf('export function checkPath('));
    expect(body.indexOf('INVISIBLE.test(raw)')).toBeGreaterThan(0);
    expect(body.indexOf('INVISIBLE.test(raw)')).toBeLessThan(body.indexOf('.normalize('));
    expect(body.indexOf('INVISIBLE.test(raw)')).toBeLessThan(body.indexOf('foldKey('));
  });

  it('needs a runtime whose Unicode is at least the table\'s, and says so otherwise', () => {
    expect(TABLE_UNICODE).toBe('16.0.0');
    for (const have of ['16.0', '16.0.0', '16.1', '17.0']) expect(unicodeProblem(have), have).toBeNull();
    for (const have of ['15.1', '15.1.0', '9.0', undefined, '']) expect(unicodeProblem(have), String(have)).toMatch(/Unicode 16\.0\.0/);
    expect(unicodeProblem(process.versions.unicode)).toBeNull();
  });

  it('is the only Unicode source the path rules read: no property escape in their modules', () => {
    for (const file of ['tree.ts', 'manifest.ts']) {
      const source = readFileSync(join(core, 'src', 'skill-tree', file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      expect(/\\[pP]\{/.test(source), file).toBe(false);
    }
  });
});
