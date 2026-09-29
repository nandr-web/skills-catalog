// skills-catalog stats (contract §3): the usage summary on this machine, in the surface's words: the window, the six
// measures, then what asks for a review of when updates are held. Read from $SKILLS_HOME/usage only; nothing leaves the
// machine, and no skill is named (the events hold only hashes).
import { describe, expect, it } from 'vitest';
import { recordUsage } from '../src/usage/record.ts';
import { COMMANDS } from '../src/cli/run.ts';
import { cli, S } from './cli-io.ts';
import { place, type Place } from './server.ts';

const runStats = (p: Place) => cli(p, ['stats']);

const DAY = 86_400_000;
const w = (path: string, fields: Record<string, unknown> = {}) => S.format(S.word(`stats.${path}`), fields);
const date = (d: Date) => d.toISOString().slice(0, 10);

describe('stats', () => {
  it('with nothing counted yet, says so', async () => {
    const p = place();
    const r = await runStats(p);
    expect([r.code, r.err, r.out.trimEnd()]).toEqual([0, '', w('empty')]);
  });

  it('shows the window, the six measures and what asks for a review, in the surface\'s words', async () => {
    const p = place();
    const now = Date.now();
    const at = (days: number, seconds = 0) => new Date(now - days * DAY + seconds * 1000);
    recordUsage(p.home, { event: 'hold', skill: 'release-notes-kit', version: 2, reason: 'flagged', flags: ['runnable_file'], behind: 1 }, at(20), { createKey: true });
    recordUsage(p.home, { event: 'hold', skill: 'sql-migration-helper', version: 3, reason: 'notify', flags: [], behind: 1 }, at(5), { createKey: true });
    recordUsage(p.home, { event: 'look', skill: 'sql-migration-helper', version: 3, face: 'cli' }, at(5, 60), { createKey: true });
    recordUsage(p.home, { event: 'answer', skill: 'sql-migration-helper', version: 3, answer: 'yes', together: 1 }, at(5, 90), { createKey: true });
    recordUsage(p.home, { event: 'hold', skill: 'demo-skill-01', version: 4, reason: 'pin', flags: [], behind: 2 }, at(2), { createKey: true });
    for (const d of [3, 2, 1]) recordUsage(p.home, { event: 'mode', face: 'hook' }, at(d));
    recordUsage(p.home, { event: 'notice', face: 'hook', waiting: 1 }, at(1));
    recordUsage(p.home, { event: 'policy', from: 'auto', to: 'pin', scope: 'skill', near_hold: false }, at(1));
    const r = await runStats(p);
    expect([r.code, r.err]).toEqual([0, '']);
    expect(r.out.trimEnd().split('\n')).toEqual([
      w('header', { days: 20, from: date(at(20)), to: date(new Date(now)) }),
      w('holds', { total: 3, last_7_days: 2, by_reason: [w('by_reason.pin', { n: 1 }), w('by_reason.notify', { n: 1 }), w('by_reason.flagged', { n: 1 })].join(', ') }),
      w('sessions', { with_notice: 1, count: 3, share: '33%' }),
      w('looks', { holds_looked: 1, holds_answered: 1, median_part: w('median_part', { seconds: 30 }) }),
      w('answers', { yes: 1, no: 0, pin: 0, superseded: 0, rate_part: w('rate_part', { yes_rate: '100%' }) }),
      w('waiting', { open_holds: 1, oldest_part: w('oldest_part', { oldest_days: 20 }) }),
      w('turned_off', { changes: 1, within_a_day: 0 }),
      w('review_header'),
      w('review.load_waiting', { waited_days: 20 }),
    ]);
    expect(r.out).not.toMatch(/release|sql|demo/);
  });

  it('a review for a skill pinned soon after a held update names it as avoidance; with no answers the parts that need them are left out', async () => {
    const p = place();
    const now = Date.now();
    recordUsage(p.home, { event: 'hold', skill: 'a', version: 2, reason: 'flagged', flags: [], behind: 1 }, new Date(now - 2 * DAY), { createKey: true });
    recordUsage(p.home, { event: 'policy', from: 'auto', to: 'pin', scope: 'skill', near_hold: false }, new Date(now - DAY));
    const r = await runStats(p);
    const lines = r.out.trimEnd().split('\n');
    expect(lines).toContain(w('looks', { holds_looked: 0, holds_answered: 0, median_part: '' }));
    expect(lines).toContain(w('answers', { yes: 0, no: 0, pin: 0, superseded: 0, rate_part: '' }));
    expect(lines.at(-1)).toBe(w('review.avoidance', { what: w('review_avoidance.skill_pinned') }));
  });
});

describe('stats as a command', () => {
  it('is served, and takes no words: `stats x` gets the usage and exits 1, and nothing is counted', async () => {
    const p = place();
    expect(Object.keys(COMMANDS)).toContain('stats');
    const r = await cli(p, ['stats', 'x']);
    expect(r.code).toBe(1);
    expect((await runStats(p)).out.trimEnd()).toBe(S.format(S.word('stats.empty'), {}));
  });
});
