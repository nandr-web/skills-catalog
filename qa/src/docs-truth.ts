// The docs that say what's built must stay true (review V2.2, P11.3, P13.4, V5.2): requirements.md is generated from the
// requirement list (requirements/*.yaml) and qa/traceability.yaml by the design notes' exporter, which stamps the page with
// a fingerprint of those inputs; this side recomputes it, so a change to either input without regenerating the page fails
// `npm run check`. decisions.md's tallies are counted from its own rows. The hash recipe is the exporter's, byte for byte:
// sha256 over each input in order (the requirement files by name, then the traceability file), each as
// "<path>\n<byte length>\n" then its bytes; the first 16 hex characters.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './trace-check.ts';

export const REQUIREMENTS_PAGE = 'docs/requirements.md';
export const DECISIONS_PAGE = 'docs/decisions.md';

/** The requirements page's inputs, as paths from the repo's root, in the order they're hashed. */
export function requirementInputs(repo = REPO): string[] {
  const dir = join(repo, 'requirements');
  const items = existsSync(dir) ? readdirSync(dir).filter((f) => /^skill-.*\.yaml$/.test(f)).sort() : [];
  return [...items.map((f) => `requirements/${f}`), 'qa/traceability.yaml'];
}

/** The fingerprint of the requirements page's inputs (the exporter's recipe). */
export function inputsHash(repo = REPO): string {
  const h = createHash('sha256');
  for (const p of requirementInputs(repo)) {
    const bytes = readFileSync(join(repo, p));
    h.update(`${p}\n${bytes.length}\n`);
    h.update(bytes);
  }
  return h.digest('hex').slice(0, 16);
}

/** The stamp the exporter wrote into the page: `inputs sha256:<16 hex>` in its first comment. */
export function pageStamp(text: string): string | undefined {
  return /<!--[^]*?\binputs sha256:([0-9a-f]{16})\b[^]*?-->/.exec(text)?.[1];
}

/** What's wrong with the requirements page: nothing when its stamp matches the inputs as they are now. */
export function requirementsPageProblems(repo = REPO): string[] {
  const file = join(repo, REQUIREMENTS_PAGE);
  if (!existsSync(file)) return [`${REQUIREMENTS_PAGE} is missing`];
  const stamp = pageStamp(readFileSync(file, 'utf8'));
  if (!stamp) return [`${REQUIREMENTS_PAGE} has no inputs stamp: generate it with the requirement exporter (md mode)`];
  const now = inputsHash(repo);
  return stamp === now ? [] : [
    `${REQUIREMENTS_PAGE} is out of date: it was generated from inputs ${stamp}, and requirements/*.yaml or qa/traceability.yaml are now ${now}. Regenerate it with the requirement exporter (md mode)`,
  ];
}

/** One row of the decision log: its id, its "Decided by" cell and its last ("Built") cell. */
export interface DecisionRow { id: string; by: string; built: string; section: string }

/** The decision log's rows (D1-D3 from the PRD, B1 onward), with the section each sits in. */
export function decisionRows(text: string): DecisionRow[] {
  const rows: DecisionRow[] = [];
  let section = '';
  let by = -1;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) { section = line.slice(3).trim(); by = -1; continue; }
    if (!line.startsWith('|')) continue;
    const cells = line.slice(1, line.endsWith('|') ? -1 : undefined).split('|').map((c) => c.trim());
    if (cells[0] === '#') { by = cells.indexOf('Decided by'); continue; }
    if (by >= 0 && /^[DB]\d+$/.test(cells[0] ?? '')) rows.push({ id: cells[0]!, by: cells[by] ?? '', built: cells.at(-1) ?? '', section });
  }
  return rows;
}

/** The groups the log counts, in its order: a row's group comes from its "Decided by" cell. */
export const DECISION_GROUPS = [
  { name: 'The PRD', by: (b: string) => b === 'The PRD' },
  { name: 'The owner', by: (b: string) => b === 'The owner' },
  { name: 'The team', by: (b: string) => b === 'The team' },
  { name: 'Defaults awaiting the owner', by: (b: string) => b === 'The team (default, awaiting the owner)' },
] as const;

/** What's wrong with the decision log's numbering and tallies: nothing when every count is the rows' own. */
export function decisionProblems(text: string): string[] {
  const rows = decisionRows(text);
  const problems: string[] = [];
  const ids = rows.map((r) => r.id);
  const prd = ids.filter((i) => i.startsWith('D'));
  if (prd.join(',') !== 'D1,D2,D3') problems.push(`the PRD's decisions should be D1, D2, D3 in order; found ${prd.join(', ') || 'none'}`);
  const ours = ids.filter((i) => i.startsWith('B'));
  ours.forEach((id, k) => { if (id !== `B${k + 1}`) problems.push(`decision ${k + 1} is numbered ${id}; B1 onward run in order, each once`); });
  const unknown = rows.filter((r) => !DECISION_GROUPS.some((g) => g.by(r.by)));
  for (const r of unknown) problems.push(`${r.id}: "Decided by" is "${r.by}", none of ${DECISION_GROUPS.map((g) => g.name).join(', ')}`);
  const count = DECISION_GROUPS.map((g) => rows.filter((r) => g.by(r.by)));
  const notBuilt = count.map((rs) => rs.filter((r) => /^Not built/.test(r.built)).length);
  const glance = /\*\*At a glance:\*\* (\d+) decisions: (\d+) from the PRD, (\d+) by the owner, (\d+) by the team, (\d+) defaults awaiting the owner\./.exec(text);
  const want = [rows.length, ...count.map((rs) => rs.length)];
  if (!glance) problems.push('no "At a glance" line: "**At a glance:** N decisions: N from the PRD, N by the owner, N by the team, N defaults awaiting the owner."');
  else if (glance.slice(1).map(Number).join(',') !== want.join(',')) problems.push(`the "At a glance" line says ${glance.slice(1).join(', ')}; the rows give ${want.join(', ')}`);
  DECISION_GROUPS.forEach((g, k) => {
    const row = new RegExp(`^\\| ${g.name} \\| (\\d+) \\| (\\d+) \\|$`, 'm').exec(text);
    if (!row) problems.push(`the tally table has no row for ${g.name}`);
    else if (Number(row[1]) !== count[k]!.length || Number(row[2]) !== notBuilt[k]) {
      problems.push(`the tally table says ${g.name}: ${row[1]} decisions, ${row[2]} not built yet; the rows give ${count[k]!.length} and ${notBuilt[k]}`);
    }
  });
  return problems;
}

/** Words the owner ruled out for these pages (review V2.6, V5.6, V6.4): "registry" next to "catalog", and the reader or
 *  "an AI assistant" as an actor. Each page lists the rules it keeps. */
export const WORD_RULES = {
  registry: { pattern: /\bregistry\b/i, why: 'the owner calls the list of operations "the API" and the shared skills "the catalog"' },
  actor: { pattern: /\bAI assistants?\b|\byour (?:machine|assistant|AWS)\b|\byou(?:r)? (?:machine|AWS account)\b/i, why: 'the actors are the Developer and the Assistant' },
} as const;

export const WORD_PAGES: Record<string, (keyof typeof WORD_RULES)[]> = {
  'docs/architecture.md': ['registry', 'actor'],
  'docs/decisions.md': ['registry', 'actor'],
  'docs/agent-experience.md': ['registry', 'actor'],
  'docs/requirements.md': ['registry'],     // the requirements keep the PRD's own words ("an AI assistant")
  'docs/contract.md': ['registry'],
  'docs/api.md': ['registry'],
  'qa/qa-plan.md': ['registry'],
};

/** Each line of a page that breaks one of its word rules. */
export function wordProblems(repo = REPO): string[] {
  const out: string[] = [];
  for (const [page, rules] of Object.entries(WORD_PAGES)) {
    const file = join(repo, page);
    if (!existsSync(file)) { out.push(`${page} is missing`); continue; }
    readFileSync(file, 'utf8').split('\n').forEach((line, k) => {
      for (const r of rules) {
        const m = WORD_RULES[r].pattern.exec(line);
        if (m) out.push(`${page}:${k + 1}: "${m[0]}" (${WORD_RULES[r].why})`);
      }
    });
  }
  return out;
}
