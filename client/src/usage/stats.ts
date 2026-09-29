// Usage metrics, the summary behind `skills-catalog stats` (contract §3): six measures of what update holds cost the
// person and whether they changed an answer, and §5.3's four rules that ask for the flag-only approvals to be reviewed.
// A pure function of the kept events. A hold is one skill version held for one reason, however many syncs report it; a
// look and an answer join their hold by skill (the hash) and version.
import { USAGE_DAYS, type StoredEvent } from './record.ts';

/** The review's starting thresholds, from the friction research (contract §5.3), to be tuned. */
export const REVIEW = {
  avoidance_days: 7,
  habit_min_answered: 20,
  habit_yes_rate: 0.95,
  habit_quick_seconds: 10,
  no_value_first: 100,
  load_session_share_over: 1 / 3,
  // Below this many sessions a share says little; a few people's single events show in the other rules.
  load_min_sessions: 3,
  load_wait_days: 14,
} as const;

type Reason = 'flagged' | 'notify' | 'pin' | 'cooldown';
type Answer = 'yes' | 'no' | 'pin' | 'superseded';

export type ReviewRule =
  | { rule: 'avoidance'; days_after_hold: number; to: string; scope: string }
  | { rule: 'habit_of_yes'; answered: number; yes_rate: number; quick_or_unlooked_share: number }
  | { rule: 'no_value_yet'; answered: number }
  | { rule: 'load'; session_share: number | null; oldest_wait_days: number | null };

export type UsageStats = {
  empty: boolean;
  window: { days: number; from: string | null; to: string };
  holds: { total: number; last_7_days: number; by_reason: Record<Reason, number> };
  sessions: { count: number; with_notice: number; share: number | null };
  looks: { holds_looked: number; holds_answered: number; median_seconds_look_to_answer: number | null };
  answers: Record<Answer, number> & { yes_rate: number | null };
  waiting: { open_holds: number; oldest_days: number | null };
  turned_off: { policy_changes_to_pin_or_notify: number; within_a_day_of_a_hold: number };
  review: ReviewRule[];
};

const DAY_MS = 86_400_000;
const ms = (iso: string) => Date.parse(iso);
const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

// One held skill version, however many syncs reported it: its reasons, when first reported, what the person did.
type Held = { first: number; reasons: Set<Reason>; flaggedFirst?: number; looks: number[]; answer?: { answer: Answer; at: number } };

export function usageStats(all: readonly StoredEvent[], now: Date = new Date()): UsageStats {
  const end = now.getTime();
  const events = all.filter((e) => ms(e.at) >= end - USAGE_DAYS * DAY_MS && ms(e.at) <= end).sort((a, b) => ms(a.at) - ms(b.at));
  const byReason: Record<Reason, number> = { flagged: 0, notify: 0, pin: 0, cooldown: 0 };
  const answers: Record<Answer, number> = { yes: 0, no: 0, pin: 0, superseded: 0 };
  const held = new Map<string, Held>();
  const seenHold = new Set<string>();
  let holdsTotal = 0;
  let holdsWeek = 0;
  let sessions = 0;
  let withNotice = 0;
  const policies: { at: number; to: string; scope: string; near: boolean }[] = [];

  for (const e of events) {
    const at = ms(e.at);
    switch (e.event) {
      case 'hold': {
        const key = `${e.skill}\u0000${e.version}`;
        const h = held.get(key) ?? { first: at, reasons: new Set<Reason>(), looks: [] };
        held.set(key, h);
        h.reasons.add(e.reason);
        if (e.reason === 'flagged') h.flaggedFirst ??= at;
        const once = `${key}\u0000${e.reason}`;
        if (!seenHold.has(once)) {
          seenHold.add(once);
          holdsTotal++;
          byReason[e.reason]++;
          if (at >= end - 7 * DAY_MS) holdsWeek++;
        }
        break;
      }
      case 'look': {
        const h = held.get(`${e.skill}\u0000${e.version}`);
        if (h && !h.answer) h.looks.push(at);
        break;
      }
      case 'answer': {
        answers[e.answer]++;
        const h = held.get(`${e.skill}\u0000${e.version}`);
        if (h && !h.answer) h.answer = { answer: e.answer, at };
        break;
      }
      case 'mode':
        if (e.surface === 'hook') sessions++;
        break;
      case 'notice':
        if (e.surface === 'hook') withNotice++;
        break;
      case 'policy':
        policies.push({ at, to: e.to, scope: e.scope, near: e.near_hold });
        break;
    }
  }

  const holds = [...held.values()];
  // Answered by the person (a newer version replacing a hold isn't their answer).
  const answered = holds.filter((h) => h.answer && h.answer.answer !== 'superseded');
  const lookToAnswer = answered.filter((h) => h.looks.length).map((h) => (h.answer!.at - h.looks.at(-1)!) / 1000);
  const decided = answers.yes + answers.no + answers.pin;
  // Waiting for the person: held to be asked (flagged, or tell me first) and not answered; pinned and cooling holds ask
  // nothing.
  const open = holds.filter((h) => !h.answer && (h.reasons.has('flagged') || h.reasons.has('notify')));
  const oldest = open.length ? Math.floor((end - Math.min(...open.map((h) => h.first))) / DAY_MS) : null;
  const off = policies.filter((p) => p.to === 'pin' || p.to === 'notify');
  const sessionShare = sessions ? withNotice / sessions : null;

  const review: ReviewRule[] = [];
  // Avoidance, once: the default turned from auto, or a skill pinned, within a week of a flagged hold.
  const flaggedAts = holds.flatMap((h) => (h.flaggedFirst === undefined ? [] : [h.flaggedFirst]));
  for (const p of off) {
    if (!(p.scope === 'catalog' || p.to === 'pin')) continue;
    const before = flaggedAts.filter((f) => f <= p.at && p.at - f <= REVIEW.avoidance_days * DAY_MS);
    if (before.length) {
      review.push({ rule: 'avoidance', days_after_hold: Math.floor((p.at - Math.max(...before)) / DAY_MS), to: p.to, scope: p.scope });
      break;
    }
  }
  // A habit of yes: enough flagged holds answered, nearly all yes, most without a look or within seconds of one.
  const flaggedAnswered = answered.filter((h) => h.flaggedFirst !== undefined);
  const flaggedYes = flaggedAnswered.filter((h) => h.answer!.answer === 'yes');
  if (flaggedAnswered.length >= REVIEW.habit_min_answered) {
    const yesRate = flaggedYes.length / flaggedAnswered.length;
    const quick = flaggedYes.filter((h) => !h.looks.length || (h.answer!.at - h.looks.at(-1)!) / 1000 <= REVIEW.habit_quick_seconds).length;
    const quickShare = flaggedYes.length ? quick / flaggedYes.length : 0;
    if (yesRate >= REVIEW.habit_yes_rate && quickShare > 0.5) review.push({ rule: 'habit_of_yes', answered: flaggedAnswered.length, yes_rate: yesRate, quick_or_unlooked_share: quickShare });
  }
  // No value yet: the first flagged holds, all answered, none declined or pinned.
  const firstFlagged = holds.filter((h) => h.flaggedFirst !== undefined).sort((a, b) => a.flaggedFirst! - b.flaggedFirst!).slice(0, REVIEW.no_value_first);
  if (firstFlagged.length === REVIEW.no_value_first && firstFlagged.every((h) => h.answer && h.answer.answer !== 'no' && h.answer.answer !== 'pin')) {
    review.push({ rule: 'no_value_yet', answered: REVIEW.no_value_first });
  }
  // Load: too many sessions open with a notice, or a hold waits too long.
  const shareHigh = sessions >= REVIEW.load_min_sessions && sessionShare !== null && sessionShare > REVIEW.load_session_share_over;
  const waitLong = oldest !== null && oldest > REVIEW.load_wait_days;
  if (shareHigh || waitLong) review.push({ rule: 'load', session_share: sessionShare, oldest_wait_days: oldest });

  const from = events[0]?.at ?? null;
  return {
    empty: events.length === 0,
    window: { days: from === null ? 0 : Math.max(1, Math.ceil((end - ms(from)) / DAY_MS)), from, to: now.toISOString() },
    holds: { total: holdsTotal, last_7_days: holdsWeek, by_reason: byReason },
    sessions: { count: sessions, with_notice: withNotice, share: sessionShare },
    looks: { holds_looked: answered.filter((h) => h.looks.length).length, holds_answered: answered.length, median_seconds_look_to_answer: median(lookToAnswer) },
    answers: { ...answers, yes_rate: decided ? answers.yes / decided : null },
    waiting: { open_holds: open.length, oldest_days: oldest },
    turned_off: { policy_changes_to_pin_or_notify: off.length, within_a_day_of_a_hold: off.filter((p) => p.near).length },
    review,
  };
}
