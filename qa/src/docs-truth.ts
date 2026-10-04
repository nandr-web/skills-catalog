// The docs that say what's built must stay true (review V2.2, P11.3, P13.4, V5.2): requirements.md is generated from the
// requirement list (requirements/*.yaml) and qa/traceability.yaml by the design notes' exporter, which stamps the page with
// a fingerprint of those inputs; this side recomputes it, so a change to either input without regenerating the page fails
// `npm run check`. The hash recipe is the exporter's, byte for byte:
// sha256 over each input in order (the requirement files by name, then the traceability file), each as
// "<path>\n<byte length>\n" then its bytes; the first 16 hex characters.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from './trace-check.ts';

export const REQUIREMENTS_PAGE = 'docs/requirements.md';

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

/** Words the owner ruled out for these pages (review V2.6, V5.6, V6.4): "registry" next to "catalog", and the reader or
 *  "an AI assistant" as an actor. Each page lists the rules it keeps. */
export const WORD_RULES = {
  registry: { pattern: /\bregistry\b/i, why: 'the owner calls the list of operations "the API" and the shared skills "the catalog"' },
  actor: { pattern: /\bAI assistants?\b|\byour (?:machine|assistant|AWS)\b|\byou(?:r)? (?:machine|AWS account)\b/i, why: 'the actors are the Developer and the Assistant' },
  review_id: { pattern: /\b[PV]\d{1,2}\.\d{1,2}\b/, why: 'a review finding\'s id is for the team, not the reader' },
} as const;

export const WORD_PAGES: Record<string, (keyof typeof WORD_RULES)[]> = {
  'docs/architecture.md': ['registry', 'actor', 'review_id'],
  'docs/decisions.yaml': ['registry', 'review_id'],      // the PRD's decisions keep the PRD's own words ("an AI assistant")
  'docs/agent-experience.md': ['registry', 'actor', 'review_id'],
  'docs/requirements.md': ['registry', 'review_id'],     // the requirements keep the PRD's own words ("an AI assistant")
  'docs/contract.md': ['registry', 'review_id'],
  'docs/api.md': ['registry', 'review_id'],
  'qa/qa-plan.md': ['registry', 'review_id'],
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
