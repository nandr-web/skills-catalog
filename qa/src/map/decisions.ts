// The decision log as data (docs/decisions.yaml): docs/decisions.md is built from it (npm run map in qa/), and the
// system map shows each decision beside the parts it's about. A decision names those parts by the map's ids (a part,
// or a box on a part's page). Where its options were weighed side by side, an aspect carries them: the options, the
// one chosen, and what drives the choice (each option's cell: a fact, and whether it counts for, even or against).
import type { Problem, Rule } from './map.ts';

/** How a cell's fact counts for its option: for, neither, against, or not known when it was weighed. */
export type Verdict = 'good' | 'even' | 'poor' | 'unknown';
export const VERDICTS: readonly Verdict[] = ['good', 'even', 'poor', 'unknown'];
export type Aspect = {
  id: string; title: string; parts: string[];
  /** What changed since it was weighed, if anything. */
  note?: string;
  options: { id: string; label: string; sub?: string }[];
  /** The option taken; none while it's still open. */
  chosen?: string;
  drivers: { name: string; toward?: string; cells: Record<string, { t: string; v?: Verdict }> }[];
};
export type Decision = {
  id: string; group: string;
  /** The bold lead of the decision (B-numbers): "What ships first:". */
  title?: string;
  text: string;
  /** What it was chosen over. */
  over?: string[];
  rationale: string; date: string; by: string;
  /** The PRD's decisions: how the build honours it. */
  honours?: string;
  built: string;
  parts?: string[];
  aspects?: Aspect[];
};
export type DecisionLog = {
  intro: string;
  /** Each group's section heading, its row in the tally table, and its words in the "At a glance" line. */
  groups: { id: string; heading: string; tally: string; glance: string; note?: string }[];
  decisions: Decision[];
  open: { id: string; question: string; owner: string; due: string }[];
};

export const DECISIONS_SOURCE = 'docs/decisions.yaml';
export const DECISIONS_PAGE = 'docs/decisions.md';

/** The decision as one table cell: its bold lead, its words, what it was chosen over. */
export function decisionCell(d: Decision): string {
  const lead = d.title ? `**${d.title}**${/^[,.;:]/.test(d.text) ? '' : ' '}` : '';
  return `${lead}${d.text}${d.over?.length ? ` Over: ${d.over.join('; ')}` : ''}`;
}

const notBuilt = (d: Decision) => /^Not built/.test(d.built);

/** docs/decisions.md, byte for byte from the data: the tallies counted, each group's table, the open questions. */
export function decisionsMarkdown(log: DecisionLog): string {
  const inGroup = (g: string) => log.decisions.filter((d) => d.group === g);
  const counts = log.groups.map((g) => inGroup(g.id));
  const out: string[] = ['# Decisions', '', log.intro.trim(), ''];
  out.push(`**At a glance:** ${log.decisions.length} decisions: ${counts.map((c, k) => `${c.length} ${log.groups[k]!.glance}`).join(', ')}.`, '');
  out.push('| Decided by | Decisions | Not built yet |', '|---|---|---|');
  log.groups.forEach((g, k) => out.push(`| ${g.tally} | ${counts[k]!.length} | ${counts[k]!.filter(notBuilt).length} |`));
  for (const g of log.groups) {
    out.push('', `## ${g.heading}`, '');
    if (g.note) out.push(g.note.trim(), '');
    const prd = inGroup(g.id).some((d) => d.honours !== undefined);
    out.push(prd ? '| # | Decision | Rationale | Date | Decided by | How the build honours it | Built |' : '| # | Decision | Rationale | Date | Decided by | Built |');
    out.push(prd ? '|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|');
    for (const d of inGroup(g.id)) out.push(`| ${[d.id, decisionCell(d), d.rationale, d.date, d.by, ...(prd ? [d.honours ?? ''] : []), d.built].join(' | ')} |`);
  }
  out.push('', '## Open', '', '| # | Question | Owner | Due |', '|---|---|---|---|');
  for (const q of log.open) out.push(`| ${q.id} | ${q.question} | ${q.owner} | ${q.due} |`);
  return out.join('\n') + '\n';
}

/** The decisions about a part: those naming it, or naming it through one of their aspects. */
export function decisionsAbout(log: DecisionLog, id: string): { decision: Decision; aspects: Aspect[] }[] {
  return log.decisions.flatMap((d) => {
    const aspects = (d.aspects ?? []).filter((a) => a.parts.includes(id));
    return (d.parts ?? []).includes(id) || aspects.length ? [{ decision: d, aspects }] : [];
  });
}

/** Every way the log is wrong: an unknown group or part, a duplicate id, a chosen option that isn't one. */
export function checkDecisions(log: DecisionLog, ids: Set<string>): Problem[] {
  const problems: Problem[] = [];
  const add = (rule: Rule, message: string) => problems.push({ rule, message });
  const groups = new Set(log.groups.map((g) => g.id));
  const seen = new Set<string>();
  for (const d of log.decisions) {
    const at = `decisions.${d.id}`;
    if (seen.has(d.id)) add('duplicate-id', `${at}: the id is used twice`);
    seen.add(d.id);
    if (!groups.has(d.group)) add('unknown-decision', `${at}: no group "${d.group}"`);
    for (const p of d.parts ?? []) if (!ids.has(p)) add('decision-unknown-part', `${at}.parts: no part or box "${p}" on the map`);
    for (const a of d.aspects ?? []) {
      const options = new Set(a.options.map((o) => o.id));
      for (const p of a.parts) if (!ids.has(p)) add('decision-unknown-part', `${at}.aspects.${a.id}.parts: no part or box "${p}" on the map`);
      if (a.chosen !== undefined && !options.has(a.chosen)) add('chosen-not-an-option', `${at}.aspects.${a.id}: chosen "${a.chosen}" is none of its options (${[...options].join(', ')})`);
      for (const dr of a.drivers) {
        if (dr.toward && dr.toward !== 'none' && !options.has(dr.toward)) add('chosen-not-an-option', `${at}.aspects.${a.id}: "${dr.name}" points toward "${dr.toward}", none of its options`);
        for (const [o, cell] of Object.entries(dr.cells)) {
          if (!options.has(o)) add('chosen-not-an-option', `${at}.aspects.${a.id}: "${dr.name}" has a cell for "${o}", none of its options`);
          if (cell.v !== undefined && !VERDICTS.includes(cell.v)) add('unknown-decision', `${at}.aspects.${a.id}: "${dr.name}" for ${o} counts as "${cell.v}", none of ${VERDICTS.join(', ')}`);
        }
      }
    }
  }
  return problems;
}
