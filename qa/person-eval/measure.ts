// What score.mjs measures in bob's answers, for a person reading them (the visual-first tenets): structure they can see
// at a glance (a table, the marks ✓ ↑ ▲ ✗, a quoted box, bold), one question at most, few words (under each ask's
// ceiling, ceilings.json), no internal terms, and still the right behaviour (the held update never taken, a close match
// never passed off as a fit). An answer is read from its stream-json trace (run.sh saves one per answer, with the product's
// own trace parser), or from a plain .md answer (runs saved before traces).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseTrace } from '../src/agent/trace.ts';

export const CEILINGS: Record<string, number> = JSON.parse(readFileSync(new URL('./ceilings.json', import.meta.url), 'utf8')).words;

const INTERNAL: [string, RegExp][] = [
  ['a tool name', /_shared_skills?\b|_installed_skills\b|accept_held_update|publish_skill_to_catalog|set_skill_update_policy/],
  ['"flags"', /\bflags?\b/i],
  ['"fingerprint"', /fingerprint/i],
  ['"front matter"', /front ?matter/i],
  ['"confirm value"', /confirm (value|token)/i],
  ['an error code', /\b(not_found|not_installed|invalid_\w+|runnable_file)\b/],
  ['"keyword match"', /keyword match/i],
];
const SAYS_NONE = /\bno\b[^.]{0,40}\b(skills?|match(es|ing)?)\b|nothing (in|matches|that)|doesn'?t have|isn'?t (a|any)|couldn'?t find|not an exact|none of|neither/i;

// What each ask must still get right.
const RIGHT: Record<string, (answer: string, log: string) => boolean> = {
  search: (a) => /release-note-draft/.test(a),
  'search-miss': (a) => SAYS_NONE.test(a),
  install: (a) => /release-note-draft/.test(a),
  diff: (a) => /collect\.sh/.test(a),
  update: (a, log) => /collect\.sh|script/i.test(a) && /\?/.test(a) && !/accept_held_update +taken/.test(log),
  list: (a) => /release-note-draft/.test(a),
};

export type Row = {
  t: string; scenario: string; costUsd?: number;
  table: number; marks: number; box: number; bold: number; questions: number; words: number; over: number;
  internal: string[]; doubts: number; right: number;
};
export type Meta = { sha?: string; model?: string; tries?: number; started?: string };
export type Scored = { rows: Row[]; costUsd: number; meta: Meta };

/** A yes/no measure as k/n with its Wilson 95% interval: with a handful of answers, the range says how little they prove. */
export function rate(xs: number[]): string {
  const n = xs.length, k = xs.reduce((a, b) => a + b, 0);
  if (!n) return '-';
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  const pct = (x: number) => Math.round(x * 100);
  return `${k}/${n} ${pct(p)}% [${pct(Math.max(0, mid - half))}–${pct(Math.min(1, mid + half))}]`;
}

/** The answer a person saw, and what it cost, from a stream-json trace. */
export function answerOf(jsonl: string): { text: string; costUsd: number } {
  const r = parseTrace(jsonl).result;
  return { text: r?.text ?? '', costUsd: r?.costUsd ?? 0 };
}

/** A saved answer: a trace, or plain text (a checkout whose try-claude.sh doesn't save traces yet), read as is. */
export function readAnswer(raw: string): { text: string; costUsd: number | undefined } {
  return parseTrace(raw).result ? answerOf(raw) : { text: raw, costUsd: undefined };
}

export function measure(answer: string, scenario: string, log: string): Omit<Row, 't' | 'scenario' | 'costUsd'> {
  const lines = answer.split('\n');
  const words = answer.split(/\s+/).filter(Boolean).length;
  const ceiling = CEILINGS[scenario];
  return {
    table: lines.some((l) => /^\s*\|?\s*:?-{3,}/.test(l) && l.includes('|')) ? 1 : 0,
    marks: (answer.match(/[✓↑▲✗]/g) ?? []).length > 0 ? 1 : 0,
    box: lines.some((l) => /^\s*>/.test(l)) ? 1 : 0,
    bold: /\*\*[^*]+\*\*/.test(answer) ? 1 : 0,
    questions: (answer.match(/\?(\s|$|\*)/g) ?? []).length,
    words,
    over: ceiling !== undefined && words > ceiling ? 1 : 0,
    internal: INTERNAL.filter(([, re]) => re.test(answer)).map(([n]) => n),
    // The assistant doubting the catalog's own words out loud (it took them for an injection)
    doubts: /injection|\bverification:/i.test(answer) ? 1 : 0,
    right: RIGHT[scenario] ? (RIGHT[scenario](answer, log) ? 1 : 0) : 1,
  };
}

/** One run folder: bob's answers (a try whose setup failed left out), and what the whole run cost (every trace in it). */
export function scoreDir(dir: string): Scored {
  const files = readdirSync(dir).sort();
  const answers = new Map<string, string>();   // try-ask → its file, a trace (.jsonl) over a plain answer (.md)
  for (const f of files) {
    const m = f.match(/^(\d+)-(.+)\.(md|jsonl)$/);
    if (!m || m[2]!.startsWith('setup-') || m[2] === 'activity') continue;
    const key = `${m[1]}-${m[2]}`;
    if (m[3] === 'jsonl' || !answers.has(key)) answers.set(key, f);
  }
  let costUsd = 0;
  for (const f of files.filter((f) => f.endsWith('.jsonl'))) costUsd += readAnswer(readFileSync(join(dir, f), 'utf8')).costUsd ?? 0;
  const rows: Row[] = [];
  for (const [key, file] of [...answers].sort(([x], [y]) => x.localeCompare(y))) {
    const [, t, scenario] = key.match(/^(\d+)-(.+)$/)!;
    let log = '';
    try { log = readFileSync(join(dir, `${t}-activity.log`), 'utf8'); } catch {}
    // A try whose setup failed (ana's skills never published) says nothing about the words: left out.
    const at = (re: RegExp) => log.split('\n').findIndex((l) => re.test(l));
    const published = at(/ana .*publish_skill_to_catalog +published +release-note-draft v1/);
    if (published < 0 || published > at(/^\S+ +bob /)) continue;
    // and bob's install (the asks after it need the skill installed)
    if (at(/bob .*install_shared_skill +installed +release-note-draft v1/) < 0) continue;
    const { text, costUsd: cost } = readAnswer(readFileSync(join(dir, file), 'utf8'));
    rows.push({ t: t!, scenario: scenario!, costUsd: cost, ...measure(text, scenario!, log) });
  }
  const metaFile = join(dir, 'meta.json');
  const meta: Meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  return { rows, costUsd, meta };
}

/** One row per answer for the run history (a JSONL file): old answers can be re-scored without paying for them again. */
export function historyRows(dir: string, s: Scored, scored: string): Record<string, unknown>[] {
  return s.rows.map((r) => ({
    scored, run: basename(dir), started: s.meta.started ?? null, sha: s.meta.sha ?? null, model: s.meta.model ?? null,
    try: r.t, ask: r.scenario, cost_usd: r.costUsd ?? null,
    right: r.right, table: r.table, marks: r.marks, box: r.box, bold: r.bold, questions: r.questions, words: r.words,
    over: r.over, internal: r.internal, doubts: r.doubts,
  }));
}
