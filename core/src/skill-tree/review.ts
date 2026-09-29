// The built-in rules reviewer's flags (contract §5.3, §10): what a new version's text does to the assistant that reads it.
// A pure function over two versions' files, like the diff; the diff appends its flags, so a held update, the diff and a
// publish's preview all show them. Every rule reads a line once, with plain loops or patterns that can't backtrack, so a
// hostile line can't stall the review.

import { MANIFEST } from './manifest.ts';
import { flagText, isMarkdown, type DiffSide, type RiskFlag } from './diff.ts';
import { INVISIBLE, decodeText, isText, type TreeFile } from './tree.ts';
import { CatalogError } from './errors.ts';

// A CRLF is one line end; a lone CR, a lone LF, U+2028 and U+2029 each end one (contract §5.3), as in the diff's checks.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

// The default budget for a skill's length, in estimated tokens (UTF-8 bytes / 4, rounded up): 90% of real SKILL.md files
// are under it. Config can set any positive whole number.
export const DEFAULT_CONTEXT_COST_BUDGET = 5_000;
export const estimatedTokens = (bytes: number) => Math.ceil(bytes / 4);
// A budget from config, refused unless it's a positive whole number up to the largest safe one, so it can't turn the flag
// off by accident (a zero, a negative, a string, or a number that overflowed to infinity).
export function checkContextCostBudget(value: unknown): number {
  const refuse = (why: string, more: Record<string, unknown> = {}): never => {
    throw new CatalogError('invalid_request', { field: 'context_cost_budget', why, ...more });
  };
  if (typeof value !== 'number' || !Number.isInteger(value)) return refuse('not_integer');
  if (value <= 0) return refuse('too_low');
  if (value > Number.MAX_SAFE_INTEGER) return refuse('too_high', { limit: Number.MAX_SAFE_INTEGER });
  return value;
}

// A hidden character (contract §5.3): a bidi override or isolate, or any other character of §4.2's invisible set (zero-width
// spaces, tag characters, U+2800 …), except what hides nothing: a tab, a space separator (a no-break space), a variation
// selector or zero-width joiner inside an emoji sequence (every emoji with VS16 or ZWJ would otherwise hold an update), and
// a byte-order mark as a file's first character, which marks its encoding. Each candidate is one character.
const CANDIDATE = new RegExp(`[\\u202a-\\u202e\\u2066-\\u2069]|(?![\\t\\p{Zs}])(?:${INVISIBLE.source})`, 'gu');
const PICTOGRAPH = /^\p{Extended_Pictographic}$/u;
const MODIFIER = /^\p{Emoji_Modifier}$/u;
const codePoint = (c: string) => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
const pointBefore = (text: string, at: number) => (at > 0 ? String.fromCodePoint(text.codePointAt(at - (at > 1 && /[\udc00-\udfff]/.test(text[at - 1]!) ? 2 : 1))!) : '');
const pointAfter = (text: string, at: number) => (at < text.length ? String.fromCodePoint(text.codePointAt(at)!) : '');
// A variation selector after a pictograph (or before a keycap's U+20E3), or a joiner between two parts of an emoji (a
// pictograph, or one ending in a variation selector or a skin tone, then a pictograph).
function inEmoji(text: string, at: number, c: string): boolean {
  const before = pointBefore(text, at);
  const after = pointAfter(text, at + c.length);
  if (c === '\ufe0e' || c === '\ufe0f') return PICTOGRAPH.test(before) || after === '\u20e3';
  return (PICTOGRAPH.test(before) || MODIFIER.test(before) || before === '\ufe0f') && PICTOGRAPH.test(after);
}
// What writing needs and can't hide text with (contract \u00a75.3): the direction marks, which can't reorder a run; private-use
// characters, which show as icons and hold no text; and a non-joiner or joiner with a character of a script that writes
// with them on each side (Arabic, Syriac and the Indic blocks), whatever that character's category.
const DIRECTION_MARKS = new Set(['\u200e', '\u200f', '\u061c']);
const PRIVATE_USE = /^[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]$/u;
const JOINING_SCRIPT = /^[\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u08a0-\u08ff\u0900-\u0dff\ufb50-\ufdff\ufe70-\ufefe]$/u;
const inScript = (text: string, at: number, c: string) => JOINING_SCRIPT.test(pointBefore(text, at)) && JOINING_SCRIPT.test(pointAfter(text, at + c.length));
// A flag's tag sequence: U+1F3F4, then one or more tag digits or small letters, then the cancel tag U+E007F. Given the
// first tag after the flag, where the sequence ends (0 if it isn't one); each tag is looked at once.
const TAG_BASE = 0x1f3f4;
const isTag = (c: string) => c.codePointAt(0)! >= 0xe0000 && c.codePointAt(0)! <= 0xe007f;
function flagTagsEnd(text: string, at: number): number {
  if (pointBefore(text, at).codePointAt(0) !== TAG_BASE) return 0;
  let i = at;
  for (let p = text.codePointAt(i); p !== undefined && ((p >= 0xe0030 && p <= 0xe0039) || (p >= 0xe0061 && p <= 0xe007a)); p = text.codePointAt(i)) i += 2;
  return i > at && text.codePointAt(i) === 0xe007f ? i + 2 : 0;
}
function hiddenIn(text: string, fileStart: boolean): string | null {
  let spared = 0; // a flag's tag sequence runs to here
  for (const m of text.matchAll(CANDIDATE)) {
    const c = m[0];
    if (m.index < spared) continue;
    if (c === '\ufeff' && fileStart && m.index === 0) continue;
    if (DIRECTION_MARKS.has(c) || PRIVATE_USE.test(c)) continue;
    if ((c === '\ufe0e' || c === '\ufe0f' || c === '\u200d') && inEmoji(text, m.index, c)) continue;
    if ((c === '\u200c' || c === '\u200d') && inScript(text, m.index, c)) continue;
    if (isTag(c)) {
      spared = flagTagsEnd(text, m.index);
      if (spared) continue;
    }
    return c;
  }
  return null;
}

// "ignore previous instructions": ignore, disregard or forget, then optionally all, any or the, then previous, prior,
// above, earlier or system, then instruction, guidance, rule, message or prompt, singular or plural.
const IGNORE = /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the)\s+)?(?:previous|prior|above|earlier|system)\s+(?:instruction|guidance|rule|message|prompt)s?\b/i;
// "addressed to the assistant", in three forms only: "to the <noun>:" (with its colon), "note to (the) <noun>", and
// "(the) <noun> reading this", where the noun is assistant, AI, model, LLM, agent or Claude. So "Send the diff to the
// model" and "Claude should …" aren't.
const NOUN = '(?:assistant|ai|model|llm|agent|claude)s?';
const ADDRESSED = new RegExp(`\\bto\\s+the\\s+${NOUN}\\s*:|\\bnote\\s+to\\s+(?:the\\s+)?${NOUN}\\b|\\b${NOUN}\\s+reading\\s+this\\b`, 'i');

// "curl piped to a shell": curl or wget, then any later `|` followed, after blanks of any length, by the shell, given
// plainly, by path, through env or through sudo with its options (sh, bash, zsh, python or python3). Each `|` is looked at
// once, over a short window after its blanks, so the options before the shell are bounded. Or a download run through a substitution as a shell's argument:
// `sh -c "$(curl …)"`, `bash <(curl …)`, backticks around curl or wget.
const FETCHER = /\b(?:curl|wget)\b/i;
const SHELL = '(?:\\/[\\w.-]*)*\\/?(?:sh|bash|zsh|python3?)(?![\\w-])';
const SHELL_START = new Set(['s', 'b', 'z', 'p', 'e', '/']);
const INTO_SHELL = new RegExp(`^[ \\t]*(?:sudo(?:[ \\t]+[^\\s|]+){0,4}?[ \\t]+)?(?:(?:\\/[\\w.-]*)*\\/?env(?:[ \\t]+-\\S+)*[ \\t]+)?${SHELL}`, 'i');
// A substitution that opens on a download, and the shell before it (read over a short window, so still linear).
const SUBSTITUTION_OF_DOWNLOAD = /(?:\$\(|<\(|`)[ \t]*(?:curl|wget)\b/gi;
const SHELL_BEFORE = new RegExp(`(?:^|[^\\w/-])${SHELL}(?:[ \\t]+-\\S+)*[ \\t]+["']?$`, 'i');
function curlToShell(text: string): boolean {
  const from = text.search(FETCHER);
  if (from < 0) return false;
  for (let at = text.indexOf('|', from); at >= 0; at = text.indexOf('|', at + 1)) {
    // Only sudo, env, a path or a shell's own name can follow: any other first letter costs one look.
    let i = at + 1;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (!SHELL_START.has(text[i]?.toLowerCase() ?? '')) continue;
    if (INTO_SHELL.test(text.slice(i, i + 80))) return true;
  }
  for (const m of text.matchAll(SUBSTITUTION_OF_DOWNLOAD)) if (SHELL_BEFORE.test(text.slice(Math.max(0, m.index - 80), m.index))) return true;
  return false;
}

// "sends a local file or variable": curl, wget or nc with a data option (-d, --data…, --json, -F, --upload-file, -T)
// naming a home path or a variable ($…, ~/…, .ssh, .aws, .env), or with a command substitution ($(…), or a backtick
// opening one) in any later word, its URL or a header. The line is split into words once.
const SENDER = /\b(?:curl|wget|nc)\b/i;
const LOCAL = /\$|~\/|\.ssh|\.aws|\.env/;
const COMMAND_SUBSTITUTION = /\$\(|`[\w$]/;
function sendsLocal(text: string): boolean {
  const from = text.search(SENDER);
  if (from < 0) return false;
  const words = text.slice(from).split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    if (COMMAND_SUBSTITUTION.test(w)) return true;
    let arg: string | undefined;
    if (w === '-d' || w === '-F' || w === '-T' || w === '--json' || w === '--upload-file' || (w.startsWith('--data') && !w.includes('='))) arg = words[i + 1];
    else if (w.startsWith('--data') || w.startsWith('--json=') || w.startsWith('--upload-file=')) arg = w.slice(w.indexOf('=') + 1);
    else if (/^-[dFT]./.test(w)) arg = w.slice(2);
    if (arg !== undefined && LOCAL.test(arg)) return true;
  }
  return false;
}

// Markdown's link-reference comment, `[//]: # (…)`, holding letters: a line that renders as nothing.
const LINK_COMMENT = /^[ \t]*\[\/\/\]:[ \t]*#[ \t]*\(([^)]*)\)/;
const hiddenLinkComment = (text: string) => LETTER.test(LINK_COMMENT.exec(text)?.[1] ?? '');

// The first rule a line matches, of those read on the line alone (an HTML comment over several lines is read over the
// whole file).
function lineRule(text: string, fileStart: boolean): string | null {
  const hidden = hiddenIn(text, fileStart);
  if (hidden) return `hidden character ${codePoint(hidden)}`;
  if (IGNORE.test(text)) return 'ignore previous instructions';
  if (ADDRESSED.test(text)) return 'addressed to the assistant';
  if (curlToShell(text)) return 'curl piped to a shell';
  if (sendsLocal(text)) return 'sends a local file or variable';
  if (hiddenLinkComment(text)) return 'text hidden in an HTML comment';
  return null;
}

// "text hidden in an HTML comment": each <!-- … --> holding letters, from its opening line to its closing one, in one pass
// over the file. A <!-- that never closes hides the rest of the file when it starts a line (after at most three spaces:
// CommonMark's HTML block); inside a line it's shown as text, and since nothing after it closes, the first later one that
// starts a line hides the rest instead.
const LETTER = /\p{L}/u;
const startsLine = (line: string, at: number) => at >= 0 && at <= 3 && /^ *$/.test(line.slice(0, at));
function unclosed(lines: readonly string[], line: number, open: number): { open: number; close: number } | null {
  for (let k = line; k < lines.length; k++) {
    const at = k === line ? open : lines[k]!.indexOf('<!--');
    if (!startsLine(lines[k]!, at)) continue;
    let letters = LETTER.test(lines[k]!.slice(at + 4));
    for (let j = k + 1; !letters && j < lines.length; j++) letters = LETTER.test(lines[j]!);
    return letters ? { open: k, close: lines.length - 1 } : null;
  }
  return null;
}
function comments(lines: readonly string[]): { open: number; close: number }[] {
  const out: { open: number; close: number }[] = [];
  let line = 0;
  let col = 0;
  while (line < lines.length) {
    const open = lines[line]!.indexOf('<!--', col);
    if (open < 0) {
      line++;
      col = 0;
      continue;
    }
    let letters = false;
    let end = line;
    let from = open + 4;
    let at = lines[end]!.indexOf('-->', from);
    while (at < 0) {
      letters ||= LETTER.test(lines[end]!.slice(from));
      if (++end === lines.length) {
        const rest = unclosed(lines, line, open);
        if (rest) out.push(rest);
        return out;
      }
      from = 0;
      at = lines[end]!.indexOf('-->');
    }
    letters ||= LETTER.test(lines[end]!.slice(from, at));
    if (letters) out.push({ open: line, close: end });
    line = end;
    col = at + 3;
  }
  return out;
}

// A markdown file's reviewed lines: those it adds or changes (every line on a first install), by number.
function changedLines(a: TreeFile | undefined, lines: readonly string[]): boolean[] {
  const old = new Map<string, number>();
  for (const l of a && isText(a.bytes) ? decodeText(a.bytes).split(LINE_BREAK) : []) old.set(l, (old.get(l) ?? 0) + 1);
  return lines.map((l) => {
    const n = old.get(l) ?? 0;
    if (n > 0) old.set(l, n - 1);
    return n === 0;
  });
}

function promptInjection(a: TreeFile | undefined, b: TreeFile): RiskFlag[] {
  if (!isMarkdown(b.path) || !isText(b.bytes)) return [];
  const lines = decodeText(b.bytes).split(LINE_BREAK);
  const changed = changedLines(a, lines);
  // A comment is one flag at its opening line, when any of its lines was added or changed.
  const commentAt = new Set<number>();
  for (const c of comments(lines)) {
    for (let i = c.open; i <= c.close; i++) {
      if (changed[i]) {
        commentAt.add(c.open);
        break;
      }
    }
  }
  const out: RiskFlag[] = [];
  lines.forEach((text, i) => {
    const detail = (changed[i] ? lineRule(text, i === 0) : null) ?? (commentAt.has(i) ? 'text hidden in an HTML comment' : null);
    if (detail) out.push({ kind: 'prompt_injection', path: flagText(b.path), line: i + 1, detail });
  });
  return out;
}

// context_cost: SKILL.md over the budget in estimated tokens, and grown since the installed version, in those tokens (on a
// first install, whenever it's over).
function contextCost(a: TreeFile | undefined, b: TreeFile | undefined, budget: number): RiskFlag[] {
  if (!b) return [];
  const now = estimatedTokens(b.bytes.length);
  if (now <= budget || (a && now <= estimatedTokens(a.bytes.length))) return [];
  return [{ kind: 'context_cost', path: MANIFEST, detail: `about ${now} tokens (budget ${budget})` }];
}

export function reviewFlags(from: DiffSide | null, to: DiffSide, budget: number = DEFAULT_CONTEXT_COST_BUDGET): RiskFlag[] {
  const before = new Map((from?.files ?? []).map((f) => [f.path, f]));
  const out: RiskFlag[] = [];
  for (const b of to.files) out.push(...promptInjection(before.get(b.path), b));
  out.push(...contextCost(before.get(MANIFEST), to.files.find((f) => f.path === MANIFEST), budget));
  return out;
}
