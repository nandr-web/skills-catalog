// The MCP face's result for the person (person/view.ts in markdown): after the assistant's words, the same result laid
// out to be seen at a glance in the assistant's reply: tables, the marks, and what needs the person's yes in a quoted box
// that ends with the question. It never names a command to type (the person answers the assistant), never carries
// what only an assistant should read, and a publisher's text can't format itself, link or break a table.
import { Words } from '@skills-catalog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actAs } from '@skills-catalog/core';
import { request, seed, skillMd } from './seed.ts';
import { PROCESS_TEST_MS, place, startServer, type Server } from './server.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });

const S = Words.load();
const T = S.names as Record<string, string>;
const FOR_PERSON = `\n\n${S.format(S.word('person.for_person'))}\n\n`;
const person = (text: string) => {
  const parts = text.split(FOR_PERSON);
  expect(parts, 'a person view after the assistant\'s words').toHaveLength(2);
  return parts[1]!;
};

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

async function started(extra?: Parameters<typeof seed>[1]) {
  const p = place();
  await seed(p, extra);
  const s = startServer(p);
  servers.push(s);
  await s.initialize();
  return s;
}

// What only an assistant should read, and any command to type.
const NOT_FOR_PERSON = [/tell the (person|user)/i, /do not follow|don't follow/i, /_shared_skills?\b|_installed_skills\b|accept_held_update/, /\bconfirm\b/, /\bflags\b/, /skills-catalog /, /\$\{\w+\}|\{\w+\}/];

describe('the MCP result, laid out for the person', () => {
  it('a search with a full match: the matches in one table, the cards sharing only some words in their own, with those words (the review of 2026-10-02, P1.1)', async () => {
    const s = await started(async (c) => {
      await c.publish(request('semver-helper', [{ path: 'SKILL.md', text: skillMd('semver-helper', 'Works out the next release version.') }]), actAs('ben'));
    });
    const shown = person(await s.text(T['search']!, { query: 'release notes' }));
    const also = shown.indexOf(S.format(S.word('person.search.also')));
    expect(also).toBeGreaterThan(shown.indexOf('release-notes-kit'));
    expect(shown.slice(0, also)).not.toContain('semver-helper');
    expect(shown.slice(also)).toMatch(/\| \*\*semver-helper\*\* \| v1 \| ben \| release \|/);
  });

  it('a held update: a box that says why and what happens until the person says yes, asking nothing itself', async () => {
    const s = await started();
    await s.call(T['install']!, { name: 'release-notes-kit', version: 1 });
    const shown = person(await s.text(T['update']!, {}));
    const box = shown.split('\n').filter((l) => l.startsWith('>'));
    expect(box[0]).toBe('> **▲ Waiting for your OK: 1 update**');
    expect(box).toContain('> **release-notes-kit v1 → v2, not installed:**');
    expect(box).toContain('> - it adds or changes scripts/collect.sh, which can run on this machine');
    expect(box.slice(-2)).toEqual(['> It stays on v1 until you say yes.', '> Ask to see the change first, if you want to.']);
    // The one question is the assistant's to ask, in its own words: a question here too made two (measured on Opus).
    expect(shown).not.toMatch(/\?/);
    for (const re of NOT_FOR_PERSON) expect(shown, String(re)).not.toMatch(re);
  });

  it('search, installed skills, versions and a diff come as tables, with the marks', async () => {
    const s = await started();
    await s.call(T['install']!, { name: 'release-notes-kit', version: 1 });
    const found = person(await s.text(T['search']!, { query: 'graphql schema' }));
    expect(found.split('\n')[0]).toBe('**≈ Nothing matches every word of "graphql schema". Closest, sharing only some words:**');
    expect(found).toContain('| Skill | Version | Publisher | Shares only | What it does |');
    const list = person(await s.text(T['status']!, {}));
    expect(list).toMatch(/^\| ↑ \| \*\*release-notes-kit\*\* \| v1 \| v2 available(, updates on its own)? \|/m);
    const versions = person(await s.text(T['versions']!, { name: 'release-notes-kit' }));
    expect(versions).toContain('| Version | Published | By | Note |');
    const diff = person(await s.text(T['diff']!, { name: 'release-notes-kit', from: 1, to: 2 }));
    expect(diff).toContain('> **▲ Can run something new on this machine:**');
    expect(diff).toContain('| added | scripts/collect.sh | can run |');
    expect(diff).toMatch(/^```diff\n[\s\S]*\+#!\/bin\/sh[\s\S]*\n```$/m);
    for (const text of [found, list, versions, diff]) for (const re of NOT_FOR_PERSON) expect(text, `${re}\n${text}`).not.toMatch(re);
    // An update behind, or a single match: the view says so and asks nothing; the assistant asks its one question.
    const one = person(await s.text(T['search']!, { query: 'release notes' }));
    expect(one).toContain('**release-notes-kit**');
    for (const text of [one, list]) expect(text, text).not.toMatch(/\?/);
  });

  it('a publisher\'s text can\'t format itself, link, or break a table', async () => {
    const planted = 'Drafts notes | **urgent** [click](https://example.com) `x` _y_';   // (the catalog refuses < >)
    const s = await started(async (c) => {
      const { actAs } = await import('@skills-catalog/core');
      await c.publish(request('planted-md', [{ path: 'SKILL.md', text: skillMd('planted-md', planted) }]), actAs('eve'));
    });
    const shown = person(await s.text(T['search']!, { query: 'planted' }));
    const row = shown.split('\n').find((l) => l.includes('planted-md'))!;
    expect(row).toContain('Drafts notes \\| \\*\\*urgent\\*\\* \\[click\\](https://example.com) \\`x\\` \\_y\\_');
    expect(row.split(/(?<!\\)\|/).length - 2).toBe(4);   // four cells: the planted | didn't make a fifth
  });

  it('a read keeps only the assistant\'s words (the skill is for the assistant to judge first)', async () => {
    const s = await started();
    expect(await s.text(T['get']!, { name: 'release-notes-kit' })).not.toContain(FOR_PERSON);
  });
});

