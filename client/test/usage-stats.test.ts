// Usage metrics, the summary (contract §3; §5.3's review of the flag-only approvals): from the kept events, six measures
// (holds a week, sessions that open with a notice, whether and how long the person looked, the yes-rate, noes and pins,
// holds left waiting or updates turned off) and the four rules that ask for a review (avoidance, a habit of yes, no
// value yet, load). A hold is one skill version held for one reason, however many syncs report it.
import { describe, expect, it } from 'vitest';
import type { HoldReason, StoredEvent, UsageEvent } from '../src/usage/record.ts';
import { REVIEW, usageStats } from '../src/usage/stats.ts';

const NOW = new Date('2026-09-29T12:00:00Z');
const ago = (days: number, seconds = 0) => new Date(NOW.getTime() - days * 86_400_000 + seconds * 1000).toISOString();
const ev = (at: string, e: UsageEvent) => ({ v: 1, at, ...e }) as StoredEvent;
const hold = (at: string, skill: string, version: number, reason: HoldReason = 'flagged') =>
  ev(at, { event: 'hold', skill, version, reason, flags: reason === 'flagged' ? ['runnable_file'] : [], behind: 1 });
const answer = (at: string, skill: string, version: number, a: 'yes' | 'no' | 'pin' | 'superseded') => ev(at, { event: 'answer', skill, version, answer: a, together: 1 });
const look = (at: string, skill: string, version: number) => ev(at, { event: 'look', skill, version, surface: 'cli' });
const session = (at: string) => ev(at, { event: 'mode', surface: 'hook' });
const notice = (at: string) => ev(at, { event: 'notice', surface: 'hook', waiting: 1 });

describe('the measures', () => {
  it('nothing counted yet: empty measures and no review; counting starts with the first hold or notice, as its words say', () => {
    const s = usageStats([], NOW);
    expect(s.empty).toBe(true);
    expect(s.review).toEqual([]);
    expect(usageStats([ev(ago(1), { event: 'use', op: 'search_shared_skills', result: 'all' }), session(ago(1))], NOW).empty).toBe(true);
    expect(usageStats([notice(ago(1))], NOW).empty).toBe(false);
  });

  it('only a hold that waits for the person is superseded by a newer one: pinned and cooling ones asked nothing', () => {
    const s = usageStats([hold(ago(9), 'a', 2, 'pin'), hold(ago(8), 'a', 3, 'pin'), hold(ago(7), 'b', 1, 'cooldown'), hold(ago(6), 'b', 2, 'cooldown')], NOW);
    expect(s.answers.superseded).toBe(0);
  });

  it('counts a hold once per skill version and reason, however many syncs report it; the week is by first report', () => {
    const s = usageStats([hold(ago(10), 'a', 2), hold(ago(9), 'a', 2), hold(ago(3), 'a', 2), hold(ago(3), 'b', 5, 'pin'), hold(ago(2), 'c', 1, 'notify'), hold(ago(1), 'c', 1, 'notify')], NOW);
    expect(s.holds).toEqual({ total: 3, last_7_days: 2, by_reason: { other_catalog: 0, pin: 1, notify: 1, flagged: 1, cooldown: 0 } });
  });

  it('sessions that open with a notice: the hook\'s syncs are sessions, its notices those that opened with one', () => {
    const s = usageStats([session(ago(3)), notice(ago(3)), session(ago(2)), session(ago(1)), ev(ago(1), { event: 'mode', surface: 'mcp' }), ev(ago(1), { event: 'notice', surface: 'mcp', waiting: 2 })], NOW);
    expect(s.sessions).toEqual({ count: 3, with_notice: 1, share: 1 / 3 });
  });

  it('whether the person looked, how long before answering, the yes-rate, and noes and pins', () => {
    const s = usageStats(
      [
        hold(ago(5), 'a', 2), look(ago(5, 60), 'a', 2), answer(ago(5, 90), 'a', 2, 'yes'),
        hold(ago(4), 'b', 3), answer(ago(4, 5), 'b', 3, 'yes'),
        hold(ago(3), 'c', 1), look(ago(3, 10), 'c', 1), answer(ago(3, 70), 'c', 1, 'no'),
        hold(ago(2), 'd', 4, 'notify'), answer(ago(2, 30), 'd', 4, 'pin'),
        hold(ago(1), 'e', 2), answer(ago(1, 30), 'e', 2, 'superseded'),
      ],
      NOW,
    );
    expect(s.looks).toEqual({ holds_looked: 2, holds_answered: 4, median_seconds_look_to_answer: 45 });
    expect(s.answers).toEqual({ yes: 2, no: 1, pin: 1, superseded: 1, yes_rate: 0.5 });
  });

  it('holds left waiting: flagged or tell-me-first with no answer yet (pinned and cooling ones ask nothing), and updates turned off', () => {
    const s = usageStats(
      [
        hold(ago(20), 'a', 2), hold(ago(6), 'b', 1, 'notify'), hold(ago(6), 'c', 1, 'pin'), hold(ago(5), 'd', 3), answer(ago(4), 'd', 3, 'yes'),
        ev(ago(3), { event: 'policy', from: 'auto', to: 'notify', scope: 'catalog', near_hold: true }),
        ev(ago(2), { event: 'policy', from: 'notify', to: 'auto', scope: 'catalog', near_hold: false }),
        ev(ago(1), { event: 'policy', from: 'auto', to: 'pin', scope: 'skill', near_hold: false }),
      ],
      NOW,
    );
    expect(s.waiting).toEqual({ open_holds: 2, oldest_days: 20 });
    expect(s.turned_off).toEqual({ policy_changes_to_pin_or_notify: 2, within_a_day_of_a_hold: 1 });
  });

  it('a skill held because it came from another catalog waits for the person too', () => {
    const s = usageStats([hold(ago(3), 'a', 1, 'other_catalog'), hold(ago(2), 'b', 1, 'cooldown')], NOW);
    expect(s.waiting).toEqual({ open_holds: 1, oldest_days: 3 });
    expect(s.holds.by_reason).toMatchObject({ other_catalog: 1, cooldown: 1 });
  });

  it('a newer version held for the same skill supersedes the older hold: it no longer waits, and counts as superseded', () => {
    const s = usageStats([hold(ago(20), 'a', 2), hold(ago(10), 'a', 3), hold(ago(9), 'a', 3), hold(ago(5), 'b', 1)], NOW);
    expect(s.waiting).toEqual({ open_holds: 2, oldest_days: 10 });
    expect(s.answers.superseded).toBe(1);
    expect(s.looks.holds_answered).toBe(0);
    const twice = usageStats([hold(ago(20), 'a', 2), hold(ago(10), 'a', 3), answer(ago(9), 'a', 2, 'superseded'), answer(ago(8), 'a', 3, 'yes'), answer(ago(7), 'a', 3, 'yes')], NOW);
    expect(twice.answers).toMatchObject({ superseded: 1, yes: 1 });
  });

  it('only the kept days count', () => {
    const s = usageStats([hold(ago(120), 'a', 1), hold(ago(10), 'b', 1)], NOW);
    expect(s.holds.total).toBe(1);
    expect(s.window.days).toBe(10);
  });
});

describe('the review of the flag-only approvals', () => {
  const rules = (events: StoredEvent[]) => usageStats(events, NOW).review.map((r) => r.rule);

  it('avoidance, once: the default turned from auto, or a skill pinned, within 7 days of a flagged hold', () => {
    const turned = ev(ago(2), { event: 'policy', from: 'auto', to: 'notify', scope: 'catalog', near_hold: false });
    expect(rules([hold(ago(8), 'a', 1), turned])).toEqual(['avoidance']);
    expect(rules([hold(ago(10), 'a', 1), turned])).toEqual([]);
    expect(rules([hold(ago(8), 'a', 1, 'notify'), turned])).toEqual([]);
    expect(rules([hold(ago(3), 'a', 1), ev(ago(2), { event: 'policy', from: 'auto', to: 'pin', scope: 'skill', near_hold: true })])).toEqual(['avoidance']);
    expect(rules([hold(ago(3), 'a', 1), ev(ago(2), { event: 'policy', from: 'notify', to: 'auto', scope: 'catalog', near_hold: true })])).toEqual([]);
  });

  it(`a habit of yes: ${REVIEW.habit_min_answered}+ flagged holds answered, ${REVIEW.habit_yes_rate * 100}%+ yes, most with no look or within ${REVIEW.habit_quick_seconds} s of one`, () => {
    const many = (n: number, withLook: (i: number) => number | null, a: (i: number) => 'yes' | 'no' = () => 'yes') =>
      Array.from({ length: n }, (_, i) => {
        const at = 60 - i * 0.5;
        const l = withLook(i);
        return [hold(ago(at), `s${i}`, 1), ...(l === null ? [] : [look(ago(at, 100), `s${i}`, 1)]), answer(ago(at, 100 + (l ?? 5)), `s${i}`, 1, a(i))];
      }).flat();
    expect(rules(many(20, () => null))).toEqual(['habit_of_yes']);
    expect(rules(many(20, () => 3))).toEqual(['habit_of_yes']);
    expect(rules(many(19, () => null))).toEqual([]);
    expect(rules(many(20, () => 300))).toEqual([]);
    expect(rules(many(20, () => null, (i) => (i === 0 ? 'no' : 'yes')))).toEqual(['habit_of_yes']);
    expect(rules(many(20, () => null, (i) => (i < 2 ? 'no' : 'yes')))).toEqual([]);
  });

  it(`no value yet: the first ${REVIEW.no_value_first} flagged holds answered, none declined or pinned`, () => {
    const holds = (n: number, a: (i: number) => 'yes' | 'no' | 'pin') =>
      Array.from({ length: n }, (_, i) => [hold(ago(80 - i * 0.5), `s${i}`, 1), look(ago(80 - i * 0.5, 30), `s${i}`, 1), answer(ago(80 - i * 0.5, 600), `s${i}`, 1, a(i))]).flat();
    expect(rules(holds(100, () => 'yes'))).toContain('no_value_yet');
    expect(rules(holds(99, () => 'yes'))).not.toContain('no_value_yet');
    expect(rules(holds(100, (i) => (i === 50 ? 'pin' : 'yes')))).not.toContain('no_value_yet');
  });

  it(`load: more than 1 in ${REVIEW.load_session_share_over ** -1} sessions open with a notice, or a hold waits more than ${REVIEW.load_wait_days} days`, () => {
    expect(rules([session(ago(3)), notice(ago(3)), session(ago(2)), session(ago(1)), notice(ago(1))])).toEqual(['load']);
    expect(rules([session(ago(3)), notice(ago(3)), session(ago(2)), session(ago(1))])).toEqual([]);
    expect(rules([hold(ago(15), 'a', 1)])).toEqual(['load']);
    expect(rules([hold(ago(13), 'a', 1)])).toEqual([]);
    const r = usageStats([hold(ago(15), 'a', 1)], NOW).review[0]!;
    expect(r).toEqual({ rule: 'load', oldest_wait_days: 15 });
    expect(usageStats([session(ago(3)), notice(ago(3)), session(ago(2)), notice(ago(2)), session(ago(1))], NOW).review).toEqual([{ rule: 'load', session_share: 2 / 3 }]);
  });
});
