// Usage metrics, looks and the person's no (contract §3): a diff records a look at the version it goes to (from the CLI,
// or from the assistant's tool), and the summary counts only looks at a held version; `update <name> --accept` records
// a look when it shows the person the reasons, and their no as an answer. Skill names only as this machine's hash.
import { Surface } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, perform } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { readUsage, skillHash } from '../src/usage/record.ts';
import { usageStats } from '../src/usage/stats.ts';
import { cli } from './cli-io.ts';
import { seed } from './seed.ts';
import { place, type Place } from './server.ts';

const env = (p: Place) => ({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome });
const events = (p: Place, kind: string) => readUsage(p.home).filter((e) => e.event === kind).map(({ v, at, ...e }) => e);

describe('looks and answers', () => {
  it('a diff is a look at the version it goes to, from the CLI or from the assistant\'s tool', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2']);
    const { ctx, close } = contextFor(settingsFrom(env(p), p.dir), Surface.load(), 'mcp');
    try {
      await perform(ctx, 'diff_shared_skill_versions', 'diff', { name: 'release-notes-kit', from: 1, to: 2 });
      await perform(ctx, 'diff_shared_skill_versions', 'diff', { name: 'no-such-skill', from: 1, to: 2 });
    } finally {
      close();
    }
    const skill = skillHash(p.home, 'release-notes-kit');
    expect(events(p, 'look')).toEqual([
      { event: 'look', skill, version: 2, surface: 'cli' },
      { event: 'look', skill, version: 2, surface: 'assistant' },
    ]);
  });

  it('update --accept shows the reasons (a look) and records a no; a yes is the installer\'s to record', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['n'] });
    const skill = skillHash(p.home, 'release-notes-kit');
    expect(events(p, 'look')).toEqual([{ event: 'look', skill, version: 2, surface: 'cli' }]);
    expect(events(p, 'answer')).toEqual([{ event: 'answer', skill, version: 2, answer: 'no', together: 1 }]);
  });

  // Not yet true: the installer records its holds and a yes where a held update is taken (its calls are specified to its
  // owner; until they land, `stats` isn't served). This passes while a held-then-accepted update counts as nothing, and
  // trips when it counts: then make it a plain `it` and put stats back in the CLI's commands.
  it.fails('a held install taken after a yes counts as one hold and one yes', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['y'] });
    const s = usageStats(readUsage(p.home));
    expect([s.holds.total, s.answers.yes]).toEqual([1, 1]);
  });

  it('nothing held: update --accept records nothing', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    await cli(p, ['update', 'sql-migration-helper', '--accept'], { tty: true, answers: ['n'] });
    expect([...events(p, 'look'), ...events(p, 'answer')]).toEqual([]);
  });
});
