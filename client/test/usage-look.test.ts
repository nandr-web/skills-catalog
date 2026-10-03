// Usage metrics, looks and the person's no (contract §3): a diff records a look at the version it goes to (from the CLI,
// or from the assistant's tool), and the summary counts only looks at a held version; `update <name> --accept` records
// a look when it shows the person the reasons, and their no as an answer. Skill names only as this machine's hash.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, perform } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { readUsage, recordUsage, skillHash } from '../src/usage/record.ts';
import { usageStats } from '../src/usage/stats.ts';
import { cli } from './cli-io.ts';
import { seed } from './seed.ts';
import { place, type Place } from './server.ts';

const env = (p: Place) => ({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed });
const events = (p: Place, kind: string) => readUsage(p.home).filter((e) => e.event === kind).map(({ v, at, ...e }) => e);

describe('looks and answers', () => {
  it('a diff is a look at the version it goes to, from the CLI or from the assistant\'s tool', async () => {
    const p = place();
    await seed(p);
    // A diff is a read: on a machine with no secret yet it makes none, and its look is dropped.
    await cli(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2']);
    expect(events(p, 'look')).toEqual([]);
    expect(existsSync(join(p.home, 'confirm.key'))).toBe(false);
    // Once something that writes has made it (a hold, an answer), a diff's look counts.
    recordUsage(p.home, { event: 'hold', skill: 'release-notes-kit', version: 2, reason: 'flagged', flags: ['runnable_file'], behind: 1 }, new Date(), { createKey: true });
    await cli(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2']);
    const { ctx, close } = contextFor(settingsFrom(env(p), p.dir), Words.load(), 'mcp');
    try {
      await perform(ctx, 'diff_shared_skill_versions', 'diff', { name: 'release-notes-kit', from: 1, to: 2 });
      await perform(ctx, 'diff_shared_skill_versions', 'diff', { name: 'no-such-skill', from: 1, to: 2 });
    } finally {
      close();
    }
    const skill = skillHash(p.home, 'release-notes-kit');
    expect(events(p, 'look')).toEqual([
      { event: 'look', skill, version: 2, face: 'cli' },
      { event: 'look', skill, version: 2, face: 'assistant' },
    ]);
  });

  it('update --accept shows the reasons (a look) and records a no; a yes is the installer\'s to record', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['n'] });
    const skill = skillHash(p.home, 'release-notes-kit');
    expect(events(p, 'look')).toEqual([{ event: 'look', skill, version: 2, face: 'cli' }]);
    expect(events(p, 'answer')).toEqual([{ event: 'answer', skill, version: 2, answer: 'no', together: 1 }]);
  });

  // The same steps as the test below, which is expected to fail: here they must end well (a crash would make that one
  // "fail" for the wrong reason): the held install, the person's no and their yes all exit 0, and only the yes installs.
  it('a held install, then no, then yes: each exits 0, and only the yes installs it', async () => {
    const p = place();
    await seed(p);
    const dest = join(p.osHome, '.claude', 'skills', 'release-notes-kit');
    const held = await cli(p, ['install', 'release-notes-kit']);
    expect(held.code).toBe(3); // held: it waits for the person (review V4.1)
    expect(existsSync(dest)).toBe(false);
    const no = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['n'] });
    expect(no.code).toBe(0);
    expect(existsSync(dest)).toBe(false);
    const yes = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true);
  });

  // The installer records its holds and a yes where a held update is taken.
  it('a held install taken after a yes counts as one hold and one yes', async () => {
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
