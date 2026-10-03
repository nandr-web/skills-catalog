// Reviewers (contract §10): pluggable, independent measurements of one version of a skill. A reviewer is an id, a version
// and a run over the version's files that measures and gives grounded findings; an empty list of findings is a normal,
// complete review (the owner: reviewers are "completely fine with approving without comments when something's good").
// The built-in rules reviewer is phase 1's only one. Phase 2's agent reviewers plug in through the same shape.
//
// What the rules reviewer flags is what a skill IS, read from the whole version as a first install reads it: a script or
// an executable, a command run as it loads, a front matter key that grants tools, text that tries to steer the assistant,
// a SKILL.md over the length budget, and a publisher other than the previous version's. How a version changed (its
// instructions changed while it grants something, a file that isn't instructions) is the update hold's business: the
// installer's diff flags it for each update, so a review card stays quiet about it.

import { MANIFEST, parseFrontmatter } from './manifest.ts';
import { DEFAULT_NON_GRANTING_KEYS, DEFAULT_SAFE_FRONTMATTER_KEYS, FLAG_TEXT_MAX, diffTrees, flagText, type DiffSide, type RiskFlag, type RiskKind } from './diff.ts';
import { DEFAULT_CONTEXT_COST_BUDGET, estimatedTokens } from './review.ts';
import { decodeText, isText, type TreeFile } from './tree.ts';

/** One grounded finding: where (path and line when it has one), the text it rests on, and why it counts. */
export interface Finding {
  kind: RiskKind;
  path?: string;
  line?: number;
  evidence: string;
  why: string;
  advice?: true; // prose that only warns about the pattern: shown, never held
}

/** Findings a review doesn't list, by kind: past REVIEW_LIMITS (one kind in one file, or all of them). */
export interface Omitted {
  kind: RiskKind;
  count: number;
}

/** What a reviewer says of one version. `measurements` are numbers (never findings); `flags` are the findings in the risk
 *  flags' shape, so every face shows one verdict; `notes` only when they help the publisher; `omitted` only when some
 *  findings are past the limits. */
export interface ReviewOutcome {
  measurements: Record<string, number>;
  flags: RiskFlag[];
  findings: Finding[];
  notes?: string;
  omitted?: Omitted[];
}

/** How much one review keeps, so it stays small whatever the skill holds (a DynamoDB item is at most 400 KB; a read has a
 *  24 KB budget): a few findings of each kind in each file, a few in all, the rest counted by kind; each text cut as flag
 *  text is (200 code points); a few measurements; short notes. `bytes` is what the JSON of any bounded review stays under
 *  (worst case, every text at its longest: tested). */
export const REVIEW_LIMITS = { per_kind_and_file: 3, findings: 20, measurements: 32, measurement_name: 64, notes: 2000, bytes: 256 * 1024 } as const;

// Which of a list to keep, in order: up to the limit for each kind in each file and in all; the rest counted by kind.
function select<T extends { kind: RiskKind; path?: string }>(items: readonly T[]): { kept: number[]; omitted: Map<RiskKind, number> } {
  const per = new Map<string, number>();
  const kept: number[] = [];
  const omitted = new Map<RiskKind, number>();
  items.forEach((x, i) => {
    const key = `${x.kind}\u0000${x.path ?? ''}`;
    const n = per.get(key) ?? 0;
    if (n < REVIEW_LIMITS.per_kind_and_file && kept.length < REVIEW_LIMITS.findings) {
      per.set(key, n + 1);
      kept.push(i);
    } else omitted.set(x.kind, (omitted.get(x.kind) ?? 0) + 1);
  });
  return { kept, omitted };
}

// A flag's value (a front matter key's old or new value) as kept: itself when short, else its JSON as flag text.
const boundValue = (v: unknown): unknown => (typeof v === 'string' ? flagText(v) : v === undefined || JSON.stringify(v).length <= FLAG_TEXT_MAX ? v : flagText(JSON.stringify(v)));

function boundFlag(f: RiskFlag): RiskFlag {
  const out: RiskFlag = { ...f, detail: flagText(f.detail) };
  if (f.path !== undefined) out.path = flagText(f.path);
  if (f.field !== undefined) out.field = flagText(f.field);
  if ('from' in f) out.from = boundValue(f.from);
  if ('to' in f) out.to = boundValue(f.to);
  return out;
}

function boundFinding(f: Finding): Finding {
  const out: Finding = { ...f, evidence: flagText(f.evidence), why: flagText(f.why) };
  if (f.path !== undefined) out.path = flagText(f.path);
  return out;
}

/** Any reviewer's outcome, kept within REVIEW_LIMITS (the catalog bounds every reviewer's before storing it). Where the
 *  flags are the findings one for one (the rules reviewer's), the same ones are kept of both. */
export function boundOutcome(o: ReviewOutcome): ReviewOutcome {
  const paired = o.flags.length === o.findings.length && o.flags.every((f, i) => f.kind === o.findings[i]!.kind && f.path === o.findings[i]!.path);
  const byFindings = select(o.findings);
  const byFlags = paired ? byFindings : select(o.flags);
  const omitted = new Map<RiskKind, number>();
  for (const x of o.omitted ?? []) omitted.set(x.kind, (omitted.get(x.kind) ?? 0) + x.count);
  for (const [k, n] of (o.findings.length ? byFindings : byFlags).omitted) omitted.set(k, (omitted.get(k) ?? 0) + n);
  const measurements = Object.fromEntries(
    Object.entries(o.measurements)
      .filter(([, v]) => typeof v === 'number' && Number.isFinite(v))
      .slice(0, REVIEW_LIMITS.measurements)
      .map(([k, v]) => [k.slice(0, REVIEW_LIMITS.measurement_name), v]),
  );
  const out: ReviewOutcome = { measurements, flags: byFlags.kept.map((i) => boundFlag(o.flags[i]!)), findings: byFindings.kept.map((i) => boundFinding(o.findings[i]!)) };
  if (o.notes !== undefined) out.notes = o.notes.length <= REVIEW_LIMITS.notes ? o.notes : o.notes.slice(0, REVIEW_LIMITS.notes - 1) + '…';
  if (omitted.size) out.omitted = [...omitted].map(([kind, count]) => ({ kind, count }));
  return out;
}

/** What a reviewer reads: one version's checked files, who published it, and the version before it (null for a first
 *  version), whose publisher a publisher change is measured against. */
export interface ReviewSubject {
  files: readonly TreeFile[];
  publisher: string;
  previous: DiffSide | null;
}

export interface Reviewer {
  readonly id: string;
  readonly version: string;
  review(subject: ReviewSubject): ReviewOutcome | Promise<ReviewOutcome>;
}

/** A review as stored with its version (contract §10): its own record, keyed by the version and the reviewer, never part of
 *  the version itself, so a reviewer can run again later (a new rule, an offline sweep) and replace it. */
export interface Review extends ReviewOutcome {
  reviewer: string;
  reviewer_version: string;
  fingerprint: string;
  at: string;
}

export const RULES_REVIEWER_ID = 'rules';
// Raise it whenever a rule changes what it finds, so an offline sweep can tell a stale review from a current one.
export const RULES_REVIEWER_VERSION = '1';

// The kinds a review keeps (requirements: skill-review-flags, phase 1).
const REVIEWED: ReadonlySet<RiskKind> = new Set<RiskKind>(['runnable_file', 'runs_at_load', 'capability_frontmatter', 'prompt_injection', 'context_cost', 'new_publisher']);

export interface RulesConfig {
  contextCostBudget: number;
  safeFrontmatterKeys: readonly string[];
  nonGrantingKeys: readonly string[];
}

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/** The built-in rules reviewer: the update hold's own rules (skill-tree's diff, with the rules reviewer's flags), read as
 *  a first install reads the version, kept to what a skill is. Pure and synchronous: the catalog runs it on publish and
 *  an offline sweep runs it again over stored versions; the installer runs the same rules through its diff. */
export function rulesReviewer(config: Partial<RulesConfig> = {}): Reviewer {
  const budget = config.contextCostBudget ?? DEFAULT_CONTEXT_COST_BUDGET;
  const safe = config.safeFrontmatterKeys ?? DEFAULT_SAFE_FRONTMATTER_KEYS;
  const nonGranting = config.nonGrantingKeys ?? DEFAULT_NON_GRANTING_KEYS;
  return {
    id: RULES_REVIEWER_ID,
    version: RULES_REVIEWER_VERSION,
    review({ files, publisher, previous }: ReviewSubject): ReviewOutcome {
      // Advice included: a warning about a pattern is shown on the card and the read, though it holds nothing.
      const whole = diffTrees(null, { files, publisher }, safe, nonGranting, budget, { advice: true }).risk_flags;
      const flags = whole.filter((f) => REVIEWED.has(f.kind) && !(f.kind === 'capability_frontmatter' && f.field !== undefined && nonGranting.includes(f.field)));
      if (previous && previous.publisher !== publisher) {
        flags.push({ kind: 'new_publisher', from: flagText(previous.publisher), to: flagText(publisher), detail: flagText(`${previous.publisher} → ${publisher}`) });
      }
      // Only the flags kept get a finding, each file read into lines once: a file of 20,000 flagged lines costs one pass.
      const { kept, omitted } = select(flags);
      const lines = linesOf(files);
      const keptFlags = kept.map((i) => flags[i]!);
      const out: ReviewOutcome = { measurements: measure(files), flags: keptFlags, findings: keptFlags.map((f) => finding(f, files, lines)) };
      if (omitted.size) out.omitted = [...omitted].map(([kind, count]) => ({ kind, count }));
      return boundOutcome(out);
    },
  };
}

// What the assistant loads (contract §5.3's estimate, UTF-8 bytes / 4 rounded up): SKILL.md whole when the skill is used,
// and its name and description in every session, where the assistant decides when to use it.
function measure(files: readonly TreeFile[]): Record<string, number> {
  const md = files.find((f) => f.path === MANIFEST);
  if (!md) return { context_tokens: 0, listing_tokens: 0 };
  let listing = 0;
  if (isText(md.bytes)) {
    try {
      const fm = parseFrontmatter(decodeText(md.bytes)).frontmatter;
      const text = (v: unknown) => (typeof v === 'string' ? v : '');
      listing = estimatedTokens(Buffer.byteLength(text(fm['name']) + text(fm['description']), 'utf8'));
    } catch {
      // an unreadable front matter lists nothing; checkManifest refuses such a version before it's stored
    }
  }
  return { context_tokens: estimatedTokens(md.bytes.length), listing_tokens: listing };
}

// A finding's evidence is the text it rests on: the flagged line as written (escaped and cut as every flag text is, so a
// hidden character shows as \u{XXXX}); for a flag with no line, what was measured or found.
// Each text file's lines, split on first use.
function linesOf(files: readonly TreeFile[]): (path: string) => string[] | undefined {
  const split = new Map<string, string[] | undefined>();
  return (path) => {
    if (!split.has(path)) {
      const file = files.find((x) => x.path === path);
      split.set(path, file && isText(file.bytes) ? decodeText(file.bytes).split(LINE_BREAK) : undefined);
    }
    return split.get(path);
  };
}

function finding(f: RiskFlag, files: readonly TreeFile[], lines: (path: string) => string[] | undefined): Finding {
  const out: Finding = { kind: f.kind, evidence: evidenceOf(f, files, lines), why: f.detail, ...(f.advice ? { advice: true as const } : {}) };
  if (f.path !== undefined) out.path = f.path;
  if (f.line !== undefined) out.line = f.line;
  return out;
}

function evidenceOf(f: RiskFlag, files: readonly TreeFile[], lines: (path: string) => string[] | undefined): string {
  const file = f.path === undefined ? undefined : files.find((x) => x.path === f.path);
  if (file && f.line !== undefined) {
    const line = lines(file.path)?.[f.line - 1];
    if (line) return flagText(line);
  }
  if (f.kind === 'context_cost' && file) return flagText(`${MANIFEST}: ${estimatedTokens(file.bytes.length)} estimated tokens (${file.bytes.length} bytes)`);
  return flagText(f.path === undefined ? f.detail : `${f.path}: ${f.detail}`);
}
