// The built-in rules reviewer's flags (contract §5.3, §10): what a new version's text does to the assistant that reads it.
// A pure function over two versions' files, like the diff; the diff appends its flags, so a held update, the diff and a
// publish's preview all show them. Every rule reads a line once, with plain loops or patterns that can't backtrack, so a
// hostile line can't stall the review.

import { MANIFEST } from './manifest.ts';
import { flagText, isMarkdown, type DiffSide, type RiskFlag } from './diff.ts';
import { INVISIBLE, decodeText, isText, type TreeFile } from './tree.ts';

// A CRLF is one line end; a lone CR, a lone LF, U+2028 and U+2029 each end one (contract §5.3), as in the diff's checks.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

// The default budget for a skill's length, in estimated tokens (UTF-8 bytes / 4, rounded up): 90% of real SKILL.md files
// are under it. Config can set any positive number.
export const DEFAULT_CONTEXT_COST_BUDGET = 5_000;
export const estimatedTokens = (bytes: number) => Math.ceil(bytes / 4);

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
function hiddenIn(text: string, fileStart: boolean): string | null {
  for (const m of text.matchAll(CANDIDATE)) {
    const c = m[0];
    if (c === '\ufeff' && fileStart && m.index === 0) continue;
    if ((c === '\ufe0e' || c === '\ufe0f' || c === '\u200d') && inEmoji(text, m.index, c)) continue;
    return c;
  }
  return null;
}

// "ignore previous instructions": ignore, disregard or forget, then optionally all, any or the, then previous, prior,
// above, earlier or system, then instruction, guidance, rule, message or prompt, singular or plural.
const IGNORE = /\b(?:ignore|disregard|forget)\s+(?:(?:all|any|the)\s+)?(?:previous|prior|above|earlier|system)\s+(?:instruction|guidance|rule|message|prompt)s?\b/i;
// "addressed to the assistant": "to the assistant", "note to the AI", "the assistant reading this", "AI reading this", with
// assistant, AI, model, LLM or agent.
const ADDRESSED = /\bto\s+the\s+(?:assistant|ai|model|llm|agent)s?\b|\b(?:assistant|ai|model|llm|agent)s?\s+reading\s+this\b/i;

// "curl piped to a shell": curl or wget, then any later `|` followed by an optional `sudo` and sh, bash, zsh, python or
// python3. Each `|` is looked at once, over a short window after it.
const FETCHER = /\b(?:curl|wget)\b/i;
const INTO_SHELL = /^[ \t]*(?:sudo[ \t]+)?(?:sh|bash|zsh|python3?)(?![\w-])/i;
function curlToShell(text: string): boolean {
  const from = text.search(FETCHER);
  if (from < 0) return false;
  for (let at = text.indexOf('|', from); at >= 0; at = text.indexOf('|', at + 1)) {
    if (INTO_SHELL.test(text.slice(at + 1, at + 40))) return true;
  }
  return false;
}

// "sends a local file or variable": curl, wget or nc with a data option (-d, --data…, -F, --upload-file, -T) naming a
// home path or a variable ($…, ~/…, .ssh, .aws, .env). The line is split into words once.
const SENDER = /\b(?:curl|wget|nc)\b/i;
const LOCAL = /\$|~\/|\.ssh|\.aws|\.env/;
function sendsLocal(text: string): boolean {
  const from = text.search(SENDER);
  if (from < 0) return false;
  const words = text.slice(from).split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i]!;
    let arg: string | undefined;
    if (w === '-d' || w === '-F' || w === '-T' || w === '--upload-file' || (w.startsWith('--data') && !w.includes('='))) arg = words[i + 1];
    else if (w.startsWith('--data') || w.startsWith('--upload-file=')) arg = w.slice(w.indexOf('=') + 1);
    else if (/^-[dFT]./.test(w)) arg = w.slice(2);
    if (arg !== undefined && LOCAL.test(arg)) return true;
  }
  return false;
}

// The first rule a line matches, of those read on the line alone (the HTML comment rule reads the whole file).
function lineRule(text: string, fileStart: boolean): string | null {
  const hidden = hiddenIn(text, fileStart);
  if (hidden) return `hidden character ${codePoint(hidden)}`;
  if (IGNORE.test(text)) return 'ignore previous instructions';
  if (ADDRESSED.test(text)) return 'addressed to the assistant';
  if (curlToShell(text)) return 'curl piped to a shell';
  if (sendsLocal(text)) return 'sends a local file or variable';
  return null;
}

// "text hidden in an HTML comment": each <!-- … --> holding letters, from its opening line to its closing one, in one pass
// over the file (a comment that never closes isn't one, and everything after its opening is inside it).
const LETTER = /\p{L}/u;
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
      if (++end === lines.length) return out;
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
