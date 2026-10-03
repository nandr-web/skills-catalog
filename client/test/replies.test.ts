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

// FR-04 "an earlier version can be retrieved when asked for": reading it offers that version, and installing it keeps
// it there, so the next routine update doesn't quietly move it to the latest (review P7.2, P7.3, P3.4).
describe('an earlier version, read and installed', () => {
  it('reading v1 offers v1, not the latest (assistant and person)', async () => {
    const p = place();
    await seed(p);
    const a = await perform(ctxFor(p), 'read_shared_skill', 'read_shared_skill', { name: 'release-notes-kit', version: 1 });
    expect(a.text).toContain(S.format(S.word('get.next_version'), { name: 'release-notes-kit', version: 1, latest: 2 }));
    const r = await person(p, ['read', 'release-notes-kit', '--version', '1']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('install release-notes-kit --version 1');
  });

  it('installing v1 says the next update moves it to the latest, and how to keep it', async () => {
    const p = place();
    await seed(p);
    const ctx = ctxFor(p);
    const a = await perform(ctx, 'install_shared_skill', 'install_shared_skill', { name: 'release-notes-kit', version: 1 });
    expect(a.isError).toBeFalsy();
    expect(a.text).toContain(S.format(S.word('install.older_auto'), { name: 'release-notes-kit', version: 1, latest: 2 }));
    expect(a.text).toContain(S.format(S.word('install.live'), { name: 'release-notes-kit' }));
  });

  it('pinned by default: no warning, since it stays', async () => {
    const p = place();
    await seed(p);
    mkdirSync(p.home, { recursive: true });
    writeFileSync(join(p.home, 'config.json'), JSON.stringify({ update_policy: 'pin' }) + '\n');
    const a = await perform(ctxFor(p), 'install_shared_skill', 'install_shared_skill', { name: 'release-notes-kit', version: 1 });
    expect(a.text).not.toContain(S.format(S.word('install.older_auto'), { name: 'release-notes-kit', version: 1, latest: 2 }).slice(0, 30));
  });

  it('installing the latest by name keeps the usual policy (no pin)', async () => {
    const p = place();
    await seed(p);
    const a = await perform(ctxFor(p), 'install_shared_skill', 'install_shared_skill', { name: 'sql-migration-helper', version: 1 });
    expect(a.text).not.toContain('earlier version');
  });
});

// A pin is the person's own choice, not a question; a dry run did nothing (review V3.1, V3.7).
describe('the update view: only real questions in the box', () => {
  const UPDATE = 'update_installed_skills';
  it('a pinned skill is a plain line under the updates, and the box counts only what needs a yes', async () => {
    const p = place();
    await seed(p);
    const ctx = ctxFor(p);
    await perform(ctx, 'install_shared_skill', 'install_shared_skill', { name: 'release-notes-kit', version: 1 });
    await perform(ctx, 'set_skill_update_policy', 'set_skill_update_policy', { name: 'release-notes-kit', policy: 'pin' });
    const a = await perform(ctx, UPDATE, UPDATE, {});
    for (const shown of Object.values(views(a, UPDATE))) {
      expect(shown).toBeDefined();
      expect(shown).toContain(S.format(S.word('person.update.pinned'), { name: 'release-notes-kit', from: 1, to: 2 }).replace('release-notes-kit', ''));
      expect(shown).not.toContain('Waiting for your OK');
    }
  });

  it('a dry run marks what would update with ↑ under a title that says nothing changed', async () => {
    const p = place();
    await seed(p);
    const ctx = ctxFor(p);
    await perform(ctx, 'install_shared_skill', 'install_shared_skill', { name: 'sql-migration-helper' });
    // Nothing newer to move to: make one.
    const { open, request, skillMd } = await import('./seed.ts');
    const { actAs } = await import('@skills-catalog/core');
    const c = await open(p);
    await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.', 'Body, v2.\n') }]), actAs('ben'));
    await c.close?.();
    const a = await perform(ctx, UPDATE, UPDATE, { dry_run: true });
    const shown = views(a, UPDATE).terminal!;
    expect(shown).toContain(S.word('person.update.dry_run_title'));
    expect(shown).toMatch(/↑ sql-migration-helper v1 → v2/);
    expect(shown).not.toMatch(/✓ sql-migration-helper/);
  });
});

// The diff view: a grant in words without its field name, said once, and a long change cut with a way to the rest
// (review V3.3, V3.8).
describe('the diff view, as the person reads it', () => {
  it('a new pre-approved tool is said once, in words; a long file shows 40 lines and how to see the rest', async () => {
    const p = place();
    const { open, request, skillMd } = await import('./seed.ts');
    const { actAs } = await import('@skills-catalog/core');
    const c = await open(p);
    const long = Array.from({ length: 120 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await c.publish(request('tool-user', [{ path: 'SKILL.md', text: skillMd('tool-user', 'Uses tools.') }, { path: 'notes.md', text: 'short\n' }]), actAs('ana'));
    await c.publish(request('tool-user', [{ path: 'SKILL.md', text: '---\nname: tool-user\ndescription: Uses tools.\nallowed-tools: Bash\n---\nBody.\n' }, { path: 'notes.md', text: long }]), actAs('ana'));
    await c.close?.();
    const a = await perform(ctxFor(p), 'diff_shared_skill_versions', 'diff_shared_skill_versions', { name: 'tool-user', from: 1, to: 2 });
    const v = views(a, 'diff_shared_skill_versions', { name: 'tool-user', from: 1, to: 2 });
    for (const [medium, shown] of Object.entries(v)) {
      expect(shown, medium).toContain('it now lets the skill use Bash without asking');
      // Our words never name the field (the publisher's own changed lines below may).
      expect(shown, medium).not.toMatch(/^\s*(•|-|>\s*-) .*allowed-tools/m);
      expect(shown, medium).toMatch(/more lines/);
      expect(shown, medium).not.toContain('line 100');
    }
    expect(v.terminal).toContain('diff tool-user --from 1 --to 2');
  });
});

// install has a person view: a held install in the same box as an update, with what to type, and exit 3 (it waits for
// the person, it didn't fail); a done install says what and where (review V4.1, V3.2).
describe('install, as the person reads it', () => {
  it('held in a terminal: the box, the reason, see it and take it, exit 3', async () => {
    const p = place();
    await seed(p);
    const r = await person(p, ['install', 'release-notes-kit']);
    expect(r.code).toBe(3);
    expect(r.out).toContain('▲ Waiting for your OK: release-notes-kit v2, not installed');
    expect(r.out).toContain('scripts/collect.sh');
    expect(r.out).toContain('read release-notes-kit --version 2');
    expect(r.out).toContain('update release-notes-kit --accept');
    for (const re of FOR_ASSISTANT) expect(r.out, String(re)).not.toMatch(re);
  });

  it('done in a terminal: ✓ what, where, and how to use it', async () => {
    const p = place();
    await seed(p);
    const r = await person(p, ['install', 'sql-migration-helper']);
    expect(r.code).toBe(0);
    expect(r.out).toContain("✓ Installed sql-migration-helper v1, its files checked against the catalog's");
    expect(r.out).toContain('Use it in this session as /sql-migration-helper.');
    for (const re of FOR_ASSISTANT) expect(r.out, String(re)).not.toMatch(re);
  });

  it('held in a reply: the box asks nothing itself (the assistant asks its one question)', async () => {
    const p = place();
    await seed(p);
    const a = await perform(ctxFor(p), 'install_shared_skill', 'install_shared_skill', { name: 'release-notes-kit' });
    const shown = views(a, 'install_shared_skill').markdown!;
    expect(shown).toContain('Waiting for your OK: release-notes-kit v2, not installed');
    expect(shown).toContain('Nothing is installed until you say yes.');
    expect(shown).not.toContain('?');
  });
});

// A command line the CLI can't run, as a person reads it: which part, why, and the command's usage; no "Correct the
// call", no code (review V4.2).
describe('a command typed wrong, as the person reads it', () => {
  it('a missing --from, a policy that isn\'t one, a bad --as', async () => {
    const p = place();
    await seed(p);
    for (const [argv, part, usage] of [
      [['diff', 'release-notes-kit'], '--from', 'diff <name> --from <from> --to <to>'],
      [['policy', 'sometimes'], 'policy', 'policy <auto|notify|pin> [<name>]'],
      [['search', 'notes', '--as', 'Bad!'], '--as', 'search <words>'],
    ] as const) {
      const r = await person(p, [...argv]);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err.split('\n')[0], argv.join(' ')).toMatch(new RegExp(`^✗ ${part.replace(/[-|]/g, '\\$&')} .*Nothing was done\\.$`));
      expect(r.err, argv.join(' ')).toContain(usage);
      expect(r.err, argv.join(' ')).not.toMatch(/invalid_request|Correct the/);
    }
  });
});

// Dates as the person reads them: their own date and time, so two versions the same day differ (review P11.4).
describe('version dates, as the person reads them', () => {
  it('versions shows each version\'s local date and time', async () => {
    const p = place();
    await seed(p);
    const r = await person(p, ['versions', 'release-notes-kit']);
    // Each row: vN, then the local date and a time; the seed's two publishes are minutes apart, so the times differ.
    const times = [...r.out.matchAll(/^\s+v\d+\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s/gm)].map((m) => m[1]);
    expect(times).toHaveLength(2);
    expect(times[0]).not.toBe(times[1]);
  });
});
