// The CLI for a person at a terminal (person/view.ts): the same results, addressed to them and laid out to be seen at a
// glance. Nothing meant for an assistant reaches them (instructions about "the person", fence markers, error codes,
// tool names), what waits for their decision comes last behind a bar with the commands that answer it, and colour is
// only ever extra: every mark and word is there without it. Without a person reading, the words are the assistant's,
// unchanged (every other CLI test).
import { describe, expect, it } from 'vitest';
import { cli, S } from './cli-io.ts';
import { open, request, seed, skillMd } from './seed.ts';
import { actAs } from '@skills-catalog/core';
import { place, type Place } from './server.ts';

const ESC = /\x1b\[/;

// What only an assistant should read: sentences addressed to it about the person, the data fences' markers and notes,
// error codes leading a line, tool names, and ${…} or {…} left unfilled.
const FOR_ASSISTANT = [
  /tell the (person|user)/i,
  /\bthe person\b/i,
  /do not follow|don't follow/i,
  /^--- (changes|SKILL\.md|end of)/m,
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/,
  /^(✗ )?[a-z]+_[a-z_]+: /m,
  /_shared_skills?\b|_installed_skills\b|accept_held_update/,
  /\$\{\w+\}|\{\w+\}/,
];

async function installedBehind(): Promise<Place> {
  const p = place();
  await seed(p);
  await cli(p, ['install', 'release-notes-kit', '--version', '1']);
  await cli(p, ['install', 'sql-migration-helper']);
  return p;
}

const person = (p: Place, argv: string[], color = false) => cli(p, argv, { person: true, color });

describe('the CLI for a person at a terminal', () => {
  it('says nothing meant only for an assistant, on any command', async () => {
    const p = await installedBehind();
    const runs = [
      ['list'], ['search', 'release', 'notes'], ['search', 'graphql', 'schema'], ['search', 'sourdough'], ['search'],
      ['read', 'release-notes-kit'], ['read', 'relase-notes-kit'], ['versions', 'release-notes-kit'],
      ['diff', 'release-notes-kit', '--from', '1', '--to', '2'], ['update', '--dry-run'], ['update'], ['install', 'nope'], ['frobnicate'],
    ];
    for (const argv of runs) {
      const r = await person(p, argv);
      const shown = r.out + r.err;
      expect(shown.trim(), argv.join(' ')).not.toBe('');
      for (const re of FOR_ASSISTANT) expect(shown, `${argv.join(' ')}: ${re}`).not.toMatch(re);
    }
  });

  it('without a person reading, the words are the assistant\'s, as before', async () => {
    const p = await installedBehind();
    for (const argv of [['update', '--dry-run'], ['search', 'graphql', 'schema'], ['list']]) {
      const plain = await cli(p, argv);
      expect(plain.out, argv.join(' ')).toMatch(/Tell the (user|person)|To bring them up to date|Installed from the shared catalog: 2 skill\(s\)/);
      expect(plain.out).not.toMatch(ESC);
    }
  });

  it('update puts what waits for the person last, behind a bar, with why and the two commands that answer it', async () => {
    const p = await installedBehind();
    const r = await person(p, ['update']);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split('\n');
    const first = lines.findIndex((l) => l.startsWith('┃'));
    expect(first).toBeGreaterThan(0);
    expect(lines.slice(first).every((l) => l.startsWith('┃'))).toBe(true);
    const block = lines.slice(first).join('\n');
    expect(block).toContain('▲ Waiting for your OK: 1 update');
    expect(block).toContain('release-notes-kit v1 → v2, not installed:');
    expect(block).toContain('• it adds or changes scripts/collect.sh, which can run on this machine');
    expect(block).toContain('skills-catalog diff release-notes-kit --from 1 --to 2');
    expect(block).toContain('skills-catalog update release-notes-kit --accept');
    expect(lines.slice(0, first).join('\n')).toMatch(/✓ +1 already up to date/);
  });

  it('list lines the skills up in columns, marking which are behind, and says how to update', async () => {
    const p = await installedBehind();
    const r = await person(p, ['list']);
    const rows = r.out.split('\n').filter((l) => /^  [✓↑]/.test(l));
    expect(rows).toHaveLength(2);
    expect(rows.find((l) => l.includes('release-notes-kit'))).toMatch(/^  ↑ .*v1 +v2 available/);
    expect(rows.find((l) => l.includes('sql-migration-helper'))).toMatch(/^  ✓ .*v1 +latest/);
    // Columns line up: each row's version starts at the same place.
    expect(new Set(rows.map((l) => l.indexOf(' v1 '))).size).toBe(1);
    expect(r.out).toContain('To update: skills-catalog update');
  });

  it('list says where a skill applies only when it is this project alone', async () => {
    const p = await installedBehind();
    await cli(p, ['install', 'demo-skill-01', '--project']);
    const rows = (await person(p, ['list'])).out.split('\n').filter((l) => /^  [✓↑]/.test(l));
    expect(rows.find((l) => l.includes('demo-skill-01'))).toContain('this project only');
    expect(rows.filter((l) => l.includes('this project'))).toHaveLength(1);
  });

  it('a search that only partly matches says so first, and names the shared words on each card', async () => {
    const p = await installedBehind();
    const r = await person(p, ['search', 'graphql', 'schema']);
    expect(r.out.split('\n')[0]).toBe('▲ Nothing matches every word of "graphql schema". Closest, sharing only some words:');
    expect(r.out).toContain('shares only: schema');
  });

  it('a search with a full match lists the cards that share only some words apart, each with those words (the review of 2026-10-02, P1.1)', async () => {
    const p = place();
    await seed(p, async (c) => {
      await c.publish(request('semver-helper', [{ path: 'SKILL.md', text: skillMd('semver-helper', 'Works out the next release version.') }]), actAs('ben'));
    });
    const r = await person(p, ['search', 'release', 'notes']);
    const lines = r.out.split('\n');
    expect(lines[0]).toBe('1 of 15 skills match "release notes"');
    const also = lines.findIndex((l) => l === `▲ ${S.format(S.word('person.search.also'))}`);
    expect(also).toBeGreaterThan(lines.findIndex((l) => l.includes('release-notes-kit')));
    expect(lines.slice(also).join('\n')).toMatch(/semver-helper[\s\S]*shares only: release/);
  });

  it('an empty catalog says it is empty, rather than to search again', async () => {
    const p = place();
    (await open(p)).close();
    const r = await person(p, ['search', 'release', 'notes']);
    expect(r.out.trim()).toBe(S.format(S.word('person.search.empty_catalog')));
  });

  it('a publisher\'s text sits behind a gutter, with its control characters shown escaped', async () => {
    const p = await installedBehind();
    const r = await person(p, ['read', 'release-notes-kit']);
    const body = r.out.split('\n').filter((l) => l.startsWith('│'));
    expect(body[0]).toBe('│ ---');
    expect(body).toContain('│ Body, second version.');
    const d = await person(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2']);
    expect(d.out).toContain('│ +#!/bin/sh');
    expect(d.out).toMatch(/┃ ▲ Can run something new on this machine:/);
  });

  it('a name not in the catalog: the sentence without its code, the similar names, a search to type', async () => {
    const p = await installedBehind();
    const r = await person(p, ['read', 'relase-notes-kit']);
    expect(r.code).toBe(1);
    expect(r.err.split('\n').slice(0, 3)).toEqual([
      '✗ No skill named "relase-notes-kit" in the shared catalog.',
      '  Did you mean: release-notes-kit?',
      '  Search by words instead: skills-catalog search <words>',
    ]);
  });

  it('colour only when asked for, and the same words either way', async () => {
    const p = await installedBehind();
    for (const argv of [['update'], ['list'], ['diff', 'release-notes-kit', '--from', '1', '--to', '2']]) {
      const plain = await person(p, argv);
      const colour = await person(p, argv, true);
      expect(plain.out).not.toMatch(ESC);
      expect(colour.out).toMatch(ESC);
      expect(colour.out.replace(/\x1b\[[0-9;]*m/g, '')).toBe(plain.out);
    }
  });

  it('a person who typed something the CLI doesn\'t take is told so before the list', async () => {
    const p = place();
    const r = await person(p, ['serach', 'x']);
    expect([r.code, r.err.split('\n')[0]]).toEqual([1, S.format(S.word('person.usage'))]);
  });

  it('update --accept names the command to look first, since the person is at this terminal', async () => {
    const p = await installedBehind();
    const r = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, person: true, answers: ['n'] });
    expect(r.out).toContain('To see exactly what changes first:  skills-catalog diff release-notes-kit --from 1 --to 2');
    expect(r.out).not.toMatch(/ask your assistant/);
    // What waits and why sits behind the bar; the answer and the result follow it.
    expect(r.out.split('\n').slice(0, 3)).toEqual([
      '┃ ▲ release-notes-kit v1 → v2 is waiting for your OK, because it adds or changes scripts/collect.sh, which can run on this machine.',
      '┃ ',
      '┃ To see exactly what changes first:  skills-catalog diff release-notes-kit --from 1 --to 2',
    ]);
    const yes = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, person: true, answers: ['y'] });
    expect(yes.out.split('\n').find((l) => l.startsWith('✓ '))).toBe("✓ Took it: release-notes-kit v1 → v2, its files checked against the catalog's.");
  });
});
