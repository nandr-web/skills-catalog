// skills-catalog stats: the usage summary on this machine (contract §3): the kept window, six measures of what update
// holds cost and whether they changed an answer, and what asks for a review of when updates are held (§5.3). Read from
// $SKILLS_HOME/usage only, never sent anywhere; the events name no skill. Not an operation of the API: it reads
// this machine's own counts, so it runs on its own and touches no catalog. The person's only, with no MCP tool, on
// purpose (agent-first's exception for steps marked for a person, P16.6): it measures how the person answers held
// updates, including whether a hold changed their answer, so it checks the assistant's influence rather than being a
// step an assistant takes for them.
import type { Words } from '@skills-catalog/core';
import { readUsage } from '../../usage/record.ts';
import { usageStats, type ReviewRule, type UsageStats } from '../../usage/stats.ts';
import { exactly, type Command } from '../command.ts';

export const stats: Command = {
  op: 'stats',
  flags: {},
  readOnly: true,
  input: (words) => exactly(words, []),
  run: async ({ ctx, s, io, withActing }) => {
    io.stdout(withActing(renderStats(s, usageStats(readUsage(ctx.settings.home, ctx.now()), ctx.now()))) + '\n');
    return 0;
  },
};

const percent = (x: number) => `${Math.round(x * 100)}%`;

/** The summary in the words (results.stats). */
export function renderStats(s: Words, u: UsageStats): string {
  const w = (path: string, fields: Record<string, unknown> = {}) => s.format(s.word(`stats.${path}`), fields);
  if (u.empty) return w('empty');
  const date = (iso: string) => {
    const [yyyy, mm, dd] = iso.slice(0, 10).split('-');
    return s.format(s.word('date'), { yyyy, mm, dd });
  };
  const reasons = Object.entries(u.holds.by_reason).filter(([, n]) => n > 0).map(([r, n]) => w(`by_reason.${r}`, { n }));
  const lines = [
    w('header', { days: u.window.days, from: date(u.window.from!), to: date(u.window.to) }),
    u.holds.total ? w('holds', { total: u.holds.total, last_7_days: u.holds.last_7_days, by_reason: reasons.join(', ') }) : w('holds_none'),
    // With no session counted yet (the session-start hook isn't set up), there's no share to give.
    ...(u.sessions.count ? [w('sessions', { with_notice: u.sessions.with_notice, count: u.sessions.count, share: percent(u.sessions.share!) })] : []),
    w('looks', { holds_looked: u.looks.holds_looked, holds_answered: u.looks.holds_answered, median_part: u.looks.median_seconds_look_to_answer === null ? '' : w('median_part', { seconds: Math.round(u.looks.median_seconds_look_to_answer) }) }),
    w('answers', { ...u.answers, rate_part: u.answers.yes_rate === null ? '' : w('rate_part', { yes_rate: percent(u.answers.yes_rate) }) }),
    w('waiting', { open_holds: u.waiting.open_holds, oldest_part: u.waiting.oldest_days === null ? '' : w('oldest_part', { oldest_days: u.waiting.oldest_days }) }),
    w('turned_off', { changes: u.turned_off.policy_changes_to_pin_or_notify, within_a_day: u.turned_off.within_a_day_of_a_hold }),
  ];
  if (!u.review.length) return [...lines, w('review_none')].join('\n');
  return [...lines, w('review_header'), ...u.review.flatMap((r) => reviewLines(w, r))].join('\n');
}

function reviewLines(w: (path: string, fields?: Record<string, unknown>) => string, r: ReviewRule): string[] {
  switch (r.rule) {
    case 'avoidance':
      return [w('review.avoidance', { what: w(`review_avoidance.${r.scope === 'skill' ? 'skill_pinned' : 'updates_off'}`) })];
    case 'habit_of_yes':
      return [w('review.habit_of_yes', { n: r.answered, yes_rate: percent(r.yes_rate) })];
    case 'no_value_yet':
      return [w('review.no_value_yet', { n: r.answered })];
    case 'load':
      return [
        ...(r.session_share === undefined ? [] : [w('review.load_sessions', { share: percent(r.session_share) })]),
        ...(r.oldest_wait_days === undefined ? [] : [w('review.load_waiting', { waited_days: r.oldest_wait_days })]),
      ];
  }
}
