// Guided setup's refusals in the words file's sentences (contract §6, §9): an assistant file setup can't use says why in
// setup's words (with the key, never a value), an install folder that isn't safe to run from has a sentence per why, and
// the other three have theirs. Nothing is left unfilled, and a why the words don't have is shown as its data.
import { describe, expect, it } from 'vitest';
import { renderError } from '../src/render.ts';
import { Words } from '../src/words-file.ts';
import { CatalogError } from '../src/errors.ts';

const s = Words.load();
const w = s.word('errors');
const fileWhy = s.setup.file_why as Record<string, string>;
const render = (code: ConstructorParameters<typeof CatalogError>[0], data: Record<string, unknown>) => renderError(s, new CatalogError(code, data));
const unfilled = /\{[a-z_]+\}|\$\{[a-z_]+\}/;

describe("setup's words", () => {
  it('come filled for this variant: the command\'s name in place, no ${…} left anywhere', () => {
    const all = JSON.stringify(s.setup);
    expect(all).toContain(s.cli);
    expect(all).not.toMatch(/\$\{\w+\}/);
    expect(Object.keys(s.setup)).toEqual(expect.arrayContaining(['questions', 'no_terminal', 'done', 'file_why', 'by_hand', 'teardown']));
  });
});

describe("setup's refusals", () => {
  it('assistant_file_unusable: the file and why in setup\'s words, the key named where there is one', () => {
    const path = '/home/ana/.claude.json';
    for (const why of ['unreadable', 'too_big', 'not_json', 'link', 'wrong_type', 'duplicate_key', 'other_user', 'hard_linked']) {
      const key = why === 'wrong_type' || why === 'duplicate_key' ? 'mcpServers' : undefined;
      const text = render('assistant_file_unusable', { path, why, ...(key ? { key } : {}) });
      expect([why, text]).toEqual([why, s.format(w.assistant_file_unusable, { path, why: s.format(fileWhy[why]!, { key }) })]);
      expect(text).not.toMatch(unfilled);
      if (key) expect(text).toContain(key);
    }
  });

  it('install_unsafe: a sentence for each why, naming the path', () => {
    const path = '/opt/pkg/src/cli.ts';
    for (const why of ['temporary', 'path_characters', 'writable_by_others', 'too_many_files']) {
      const text = render('install_unsafe', { path, why });
      expect([why, text]).toEqual([why, s.format(w[`install_unsafe_${why}`], { path })]);
      expect(text).not.toMatch(unfilled);
    }
  });

  it('assistant_file_changed, name_taken and assistant_config_elsewhere: their sentences, filled', () => {
    const cases: [ConstructorParameters<typeof CatalogError>[0], Record<string, unknown>][] = [
      ['assistant_file_changed', { path: '/home/ana/.claude.json' }],
      ['name_taken', { path: '/home/ana/.claude.json', name: 'skills-catalog' }],
      ['assistant_config_elsewhere', { setting: 'CLAUDE_CONFIG_DIR' }],
    ];
    for (const [code, data] of cases) {
      const text = render(code, data);
      expect([code, text]).toEqual([code, s.format(w[code], data)]);
      expect(text).not.toMatch(unfilled);
    }
  });

  it('a why the words have no sentence for is shown as its data, never a sentence half filled', () => {
    expect(render('assistant_file_unusable', { path: '/p', why: 'something_new' })).toBe('assistant_file_unusable: path: /p; why: something_new');
    expect(render('install_unsafe', { path: '/p', why: 'something_new' })).toBe('install_unsafe: path: /p; why: something_new');
    // A why whose words need the key, without one: the data whole, never a sentence inside a sentence.
    expect(render('assistant_file_unusable', { path: '/p', why: 'wrong_type' })).toBe('assistant_file_unusable: path: /p; why: wrong_type');
  });
});
