// The replies a refusal or a miss gets (review 2026-10-02): each names what is really wrong, in words, never as data
// spliced into a sentence. FR-01's third criterion: a skill missing a name, a description or a body is rejected *with an
// explanation*, and that explanation is the one for what is missing.
import { describe, expect, it } from 'vitest';
import { CatalogError } from '../src/errors.ts';
import { renderError } from '../src/render.ts';
import { checkManifest } from '../src/skill-tree/index.ts';
import { Words } from '../src/words-file.ts';
import { errorOf } from './helpers.ts';

const s = Words.load();
const w = s.word('errors');
// Data that reached a sentence: an unfilled slot, a field list, a code followed by its data.
const RAW = /\{\w+\}|\bproblem: |\bfields: |\[".*"\]/;
const FOLDER = '/work/skills/release-note-draft';

const md = (text: string) => [{ path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from(text) }];
const refused = async (text: string, folder = FOLDER) => {
  const e = (await errorOf(async () => checkManifest(md(text)))) as CatalogError;
  return { e, text: renderError(s, new CatalogError(e.code, { ...e.data, folder })) };
};

describe('a SKILL.md refused for what it lacks', () => {
  it('an empty body is named as the body, and the fix asks for instructions, not a name or description', async () => {
    for (const body of ['', '\n\n   \n']) {
      const { e, text } = await refused(`---\nname: release-note-draft\ndescription: Drafts release notes.\n---\n${body}`);
      expect([e.code, e.data['fields']]).toEqual(['invalid_manifest', ['body']]);
      expect(text).toContain(w.invalid_manifest_problem.body);
      expect(text).toContain(w.invalid_manifest_fix.body);
      expect(text).not.toContain(w.invalid_manifest_problem.missing_fields);
      expect(text).not.toMatch(/a name, and a one-line description/);
      expect(text).not.toMatch(RAW);
    }
  });

  it('a missing name gets its fix in words, with a name made from the folder\'s', async () => {
    const { text } = await refused('---\ndescription: Drafts release notes.\n---\nBody.\n');
    expect(text).toContain(w.invalid_manifest_problem.name);
    expect(text).toContain(s.format(w.invalid_manifest_fix.name, { suggestion: 'release-note-draft' }));
    expect(text).not.toMatch(RAW);
    // A folder whose name can't become a skill's name: the fix without a suggestion, still in words.
    const odd = await refused('---\ndescription: Drafts release notes.\n---\nBody.\n', '/work/___');
    expect(odd.text).toContain(w.invalid_manifest_fix.name_no_suggestion);
    expect(odd.text).not.toMatch(RAW);
    // Spaces and capitals in the folder's name become the name's hyphens and lowercase.
    const spaced = await refused('---\ndescription: Drafts release notes.\n---\nBody.\n', '/work/Release Note Draft');
    expect(spaced.text).toContain('like release-note-draft');
  });

  it('a missing description is named as the description', async () => {
    const { text } = await refused('---\nname: release-note-draft\n---\nBody.\n');
    expect(text).toContain(w.invalid_manifest_problem.description);
    expect(text).toContain(w.invalid_manifest_fix.description);
    expect(text).not.toMatch(RAW);
  });

  it('several missing are named together, every one of them', async () => {
    for (const fm of ['---\nname: ""\ndescription: ""\n---\n', '---\nname:\ndescription:\n---\n']) {
      const { e, text } = await refused(fm);
      expect(e.data['fields']).toEqual(['name', 'description', 'body']);
      const all = s.format(w.list_and, { items: [w.invalid_manifest_field_words.name, w.invalid_manifest_field_words.description].join(', '), last: w.invalid_manifest_field_words.body });
      expect(text).toContain(s.format(w.invalid_manifest_problem.missing_several, { fields: all }));
      expect(text).not.toMatch(RAW);
    }
    const two = await refused('---\nname: release-note-draft\n---\n');
    expect(two.text).toContain(s.format(w.list_and, { items: w.invalid_manifest_field_words.description, last: w.invalid_manifest_field_words.body }));
  });

  it('a name YAML reads as a number or true/false is SKILL.md\'s to fix, not the call\'s', async () => {
    for (const name of ['123', 'true', '1.5']) {
      const { e, text } = await refused(`---\nname: ${name}\ndescription: Drafts release notes.\n---\nBody.\n`);
      expect([e.code, e.data['problem'], e.data['fields']]).toEqual(['invalid_manifest', 'name_not_text', ['name']]);
      expect(text).toContain(w.invalid_manifest_problem.name_not_text);
      expect(text).not.toMatch(/Correct the call|invalid_request/);
      expect(text).not.toMatch(RAW);
    }
  });

  it('never splices data into a sentence: a fix that can\'t be filled falls back to the general fix', () => {
    const text = renderError(s, new CatalogError('invalid_manifest', { folder: FOLDER, problem: 'missing_fields', fields: ['shape'] }));
    expect(text).not.toMatch(RAW);
    expect(text).toContain(w.invalid_manifest_problem.missing_fields);
  });
});
