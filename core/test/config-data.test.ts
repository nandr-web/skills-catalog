// The config tables as modules (src/skill-tree/config-data.ts): written from config/*.txt by `npm run config-modules`,
// so the core reads no file when it loads (a bundle, such as the hosted catalog's Lambda functions, has no config folder).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG_DATA_FILE, CONFIG_FILES, configModule } from '../src/skill-tree/config-module.ts';
import { CASE_FOLDING_FILE, INVISIBLE_FILE, RESERVED_NAMES_FILE } from '../src/skill-tree/index.ts';
import { CASE_FOLDING_TEXT, INVISIBLE_CHARACTERS_TEXT, RESERVED_NAMES_TEXT } from '../src/skill-tree/config-data.ts';

describe('config-data.ts', () => {
  it('is what `npm run config-modules` writes now', () => {
    const now = configModule(Object.fromEntries(Object.entries(CONFIG_FILES).map(([k, f]) => [k, readFileSync(f, 'utf8')])));
    expect(readFileSync(CONFIG_DATA_FILE, 'utf8') === now, 'src/skill-tree/config-data.ts is out of date: run `npm run config-modules` in core/').toBe(true);
  });

  it('holds each table exactly as its file', () => {
    expect(RESERVED_NAMES_TEXT).toBe(readFileSync(RESERVED_NAMES_FILE, 'utf8'));
    expect(INVISIBLE_CHARACTERS_TEXT).toBe(readFileSync(INVISIBLE_FILE, 'utf8'));
    expect(CASE_FOLDING_TEXT).toBe(readFileSync(CASE_FOLDING_FILE, 'utf8'));
  });

  it('a changed table makes a different module', () => {
    const texts = { RESERVED_NAMES_TEXT: 'a\n', INVISIBLE_CHARACTERS_TEXT: 'b\n', CASE_FOLDING_TEXT: 'c\n' };
    expect(configModule(texts)).not.toBe(configModule({ ...texts, RESERVED_NAMES_TEXT: 'a\nb\n' }));
  });

  it('the skill tree reads no file when it loads', () => {
    for (const f of ['manifest.ts', 'tree.ts']) {
      const src = readFileSync(new URL(`../src/skill-tree/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/readFileSync\(/);
    }
  });
});
