// The replies a refusal or a miss gets, on the assistant's face and in the person's view (review 2026-10-02): each
// names what is really wrong, in words; a person never reads data, codes or sentences meant for an assistant.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, perform, type Answer, type Context } from '../src/operations.ts';
import { markdown, terminal } from '../src/person/medium.ts';
import { personView } from '../src/person/view.ts';
import { settingsFrom } from '../src/settings.ts';
import { place, startServer, type Place } from './server.ts';
import { cli } from './cli-io.ts';
import { seed } from './seed.ts';

const S = Words.load();
const OP = 'publish_skill_to_catalog';
// Data that reached a sentence: an unfilled slot, a field list, a code followed by its data.
const RAW = /\{\w+\}|\bproblem: |\bfields: |\[".*"\]/;
// What only an assistant should read (person-view.test.ts's list, and the publish preview's own words).
const FOR_ASSISTANT = [/tell the (person|user)/i, /\bthe person\b/i, /^(✗ )?[a-z]+_[a-z_]+: /m, /_shared_skills?\b|_installed_skills\b|accept_held_update|publish_skill_to_catalog/, /\$\{\w+\}|\{\w+\}/];

function folder(p: Place, name: string, files: Record<string, string | { text: string; mode?: number }>): string {
  const dir = join(p.dir, 'work', name);
  for (const [path, f] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof f === 'string' ? f : f.text);
    if (typeof f !== 'string' && f.mode) chmodSync(full, f.mode);
  }
  return dir;
}

const ctxFor = (p: Place, face: 'mcp' | 'cli' = 'mcp'): Context =>
  contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_AS: 'ana', SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project')), S, face).ctx;

const views = (a: Answer, op = OP, args: Record<string, unknown> = {}) => ({ terminal: personView(S, terminal(false), op, a, args), markdown: personView(S, markdown, op, a, args) });

// FR-01's three named cases, and several at once: the assistant's sentence and both of the person's views.
const CASES: Record<string, { skill: string; problem: string; fix: string }> = {
  name: { skill: '---\ndescription: Drafts release notes.\n---\nBody.\n', problem: 'errors.invalid_manifest_problem.name', fix: 'person.errors.rejected_fix.name' },
  description: { skill: '---\nname: release-note-draft\n---\nBody.\n', problem: 'errors.invalid_manifest_problem.description', fix: 'person.errors.rejected_fix.description' },
  body: { skill: '---\nname: release-note-draft\ndescription: Drafts release notes.\n---\n\n', problem: 'errors.invalid_manifest_problem.body', fix: 'person.errors.rejected_fix.body' },
  several: { skill: '---\nname: ""\ndescription: ""\n---\n', problem: 'errors.invalid_manifest_field_words.body', fix: 'person.errors.rejected_fix.missing_several' },
};

describe('a malformed skill, rejected with an explanation (FR-01)', () => {
  for (const [what, c] of Object.entries(CASES)) {
    it(`missing ${what}: the assistant's sentence and the person's view name it, in words`, async () => {
      const p = place();
      const dir = folder(p, 'release-note-draft', { 'SKILL.md': c.skill });
      const a = await perform(ctxFor(p), OP, OP, { folder: dir });
      expect(a.isError).toBe(true);
      expect(a.text).toContain(S.word(c.problem));
      expect(a.text).not.toMatch(RAW);
      const v = views(a, OP, { folder: dir });
      for (const [medium, shown] of Object.entries(v)) {
        expect(shown, medium).toBeDefined();
        expect(shown, medium).toContain(S.word(c.problem));
        // The person's fix, with its slots filled (a name made from the folder's).
        const fix = S.format(S.word(c.fix).replace(/\{fields\}/, '§').split('§')[0]!, { suggestion: 'release-note-draft' });
        expect(shown, medium).toContain(fix);
        expect(shown, medium).toContain(S.format(S.word('person.errors.rejected_file'), { folder: 'release-note-draft' }));
        for (const re of [...FOR_ASSISTANT, RAW]) expect(shown, `${medium}: ${re}\n${shown}`).not.toMatch(re);
      }
    });
  }
});

// A person at a terminal, acting as bob (the demo's "acting as" line comes once, from the CLI).
const person = (p: Place, argv: string[], o: { tty?: boolean; answers?: string[] } = {}) => cli(p, argv, { person: true, env: { SKILLS_AS: 'bob' }, ...o });
const ACTING = '(Acting as bob, for demo purposes.)';

describe('a miss, as the person reads it', () => {
  it('a version, a file or a name typed as words: what is missing, and a command to see what there is', async () => {
    const p = place();
    await seed(p);
    const runs: [string[], string[]][] = [
      [['read', 'release-notes-kit', '--version', '9'], ['✗ release-notes-kit has no v9; the latest is v2.', '  See its versions: skills-catalog versions release-notes-kit']],
      [['diff', 'release-notes-kit', '--from', '1', '--to', '9'], ['✗ release-notes-kit has no v9; the latest is v2.', '  See its versions: skills-catalog versions release-notes-kit']],
      [['read', 'release-notes-kit', '--path', 'nope.md'], ['✗ release-notes-kit v2 has no file nope.md.', '  See its files: skills-catalog read release-notes-kit --files']],
      [['read', 'Release Notes Kit'], ['✗ "Release Notes Kit" isn\'t a skill name: names are lowercase words joined by hyphens.', '  Did you mean: release-notes-kit?']],
      [['install', 'Release Notes Kit'], ['✗ "Release Notes Kit" isn\'t a skill name: names are lowercase words joined by hyphens.', '  Did you mean: release-notes-kit?']],
      [['read', 'release'], ['✗ No skill named "release" in the shared catalog.', '  Did you mean: release-notes-kit?']],
    ];
    for (const [argv, lines] of runs) {
      const r = await person(p, argv);
      expect([argv.join(' '), r.code], r.err).toEqual([argv.join(' '), 1]);
      expect(r.err.split('\n').slice(0, lines.length), argv.join(' ')).toEqual(lines);
      expect(r.err.split(ACTING).length - 1, argv.join(' ')).toBe(1);
      for (const re of FOR_ASSISTANT) expect(r.err, `${argv.join(' ')}: ${re}`).not.toMatch(re);
    }
  });

  it('update <name> --accept for a skill not in the catalog: the person\'s words, not the assistant\'s', async () => {
    const p = place();
    await seed(p);
    const r = await person(p, ['update', 'nope', '--accept'], { tty: true });
    expect(r.code).toBe(1);
    expect(r.err.split('\n')[0]).toBe('✗ No skill named "nope" in the shared catalog.');
    for (const re of FOR_ASSISTANT) expect(r.err, String(re)).not.toMatch(re);
  });

  it('in the assistant\'s reply: what is missing, the names like it, and no question (the assistant asks its own)', async () => {
    const p = place();
    await seed(p);
    const s = startServer(p);
    await s.initialize();
    const FOR_PERSON = `\n\n${S.format(S.word('person.for_person'))}\n\n`;
    const T = S.names as Record<string, string>;
    const reply = async (tool: string, args: Record<string, unknown>) => (await s.call(tool, args)).content[0]!.text.split(FOR_PERSON)[1];
    expect(await reply(T['get']!, { name: 'relase-notes-kit' })).toBe('✗ No skill named "relase-notes-kit" in the shared catalog.\n\nNames like it: **release-notes-kit**.');
    expect(await reply(T['get']!, { name: 'release-notes-kit', version: 9 })).toBe('✗ release-notes-kit has no v9; the latest is v2.');
    expect(await reply(T['install']!, { name: 'Release Notes Kit' })).toContain('Names like it: **release-notes-kit**.');
    await s.close();
  });
});
