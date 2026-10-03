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
import { DEFAULT_NON_GRANTING_KEYS, DEFAULT_SAFE_FRONTMATTER_KEYS, diffTrees, flagText, type DiffSide, type RiskFlag, type RiskKind } from './diff.ts';
import { DEFAULT_CONTEXT_COST_BUDGET, estimatedTokens } from './review.ts';
import { decodeText, isText, type TreeFile } from './tree.ts';

/** One grounded finding: where (path and line when it has one), the text it rests on, and why it counts. */
export interface Finding {
  kind: RiskKind;
  path?: string;
  line?: number;
  evidence: string;
  why: string;
}

/** What a reviewer says of one version. `measurements` are numbers (never findings); `flags` are the findings in the risk
 *  flags' shape, so every face shows one verdict; `notes` only when they help the publisher. */
export interface ReviewOutcome {
  measurements: Record<string, number>;
  flags: RiskFlag[];
  findings: Finding[];
  notes?: string;
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
      const whole = diffTrees(null, { files, publisher }, safe, nonGranting, budget).risk_flags;
      const flags = whole.filter((f) => REVIEWED.has(f.kind) && !(f.kind === 'capability_frontmatter' && f.field !== undefined && nonGranting.includes(f.field)));
      if (previous && previous.publisher !== publisher) {
        flags.push({ kind: 'new_publisher', from: flagText(previous.publisher), to: flagText(publisher), detail: flagText(`${previous.publisher} → ${publisher}`) });
      }
      return { measurements: measure(files), flags, findings: flags.map((f) => finding(f, files)) };
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
function finding(f: RiskFlag, files: readonly TreeFile[]): Finding {
  const out: Finding = { kind: f.kind, evidence: evidenceOf(f, files), why: f.detail };
  if (f.path !== undefined) out.path = f.path;
  if (f.line !== undefined) out.line = f.line;
  return out;
}

function evidenceOf(f: RiskFlag, files: readonly TreeFile[]): string {
  const file = f.path === undefined ? undefined : files.find((x) => x.path === f.path);
  if (file && f.line !== undefined && isText(file.bytes)) {
    const line = decodeText(file.bytes).split(LINE_BREAK)[f.line - 1];
    if (line) return flagText(line);
  }
  if (f.kind === 'context_cost' && file) return flagText(`${MANIFEST}: ${estimatedTokens(file.bytes.length)} estimated tokens (${file.bytes.length} bytes)`);
  return flagText(f.path === undefined ? f.detail : `${f.path}: ${f.detail}`);
}
