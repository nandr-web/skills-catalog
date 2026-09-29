// The built-in rules reviewer's flags (contract §5.3, §10): what a new version's text does to the assistant that reads it.
// A pure function over two versions' files, like the diff; the diff appends its flags, so a held update, the diff and a
// publish's preview all show them. Every rule reads a line once, with plain loops or patterns that can't backtrack, so a
// hostile line can't stall the review.

import { MANIFEST } from './manifest.ts';
import { flagText, isMarkdown, type DiffSide, type RiskFlag } from './diff.ts';
import { INVISIBLE, decodeText, isText, type TreeFile } from './tree.ts';
import { CatalogError } from './errors.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
// The space separators are Unicode 16.0's 17 (general category Zs), listed here rather than read from the runtime's
// \p{Zs}, so a newer runtime can't change which character is hidden.
export const SPACE_SEPARATORS: readonly number[] = [0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x202f, 0x205f, 0x3000];
const SPARED_BLANK = `\\t${SPACE_SEPARATORS.map((cp) => `\\u{${cp.toString(16)}}`).join('')}`;
const CANDIDATE = new RegExp(`[\\u202a-\\u202e\\u2066-\\u2069]|(?![${SPARED_BLANK}])(?:${INVISIBLE.source})`, 'gu');
// Which characters are pictographs and skin tones comes from config/emoji-properties.txt (made by
// scripts/emoji-properties.py from Unicode's emoji-data.txt 16.0), never the runtime's properties, so a line is reviewed
// the same on every machine: sections of code-point ranges, each after its [property] line.
export const EMOJI_PROPERTIES_FILE = join(import.meta.dirname, '..', '..', 'config', 'emoji-properties.txt');
function readEmojiProperties(file = EMOJI_PROPERTIES_FILE): Map<string, RegExp> {
  const ranges = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const section = /^\[(\w+)\]$/.exec(line);
    if (section) ranges.set(section[1]!, (current = []));
    else current!.push(line.split('..').map((hex) => `\\u{${hex}}`).join('-'));
  }
  return new Map([...ranges].map(([name, r]) => [name, new RegExp(`^[${r.join('')}]$`, 'u')]));
}
const EMOJI = readEmojiProperties();
export const EXTENDED_PICTOGRAPHIC = EMOJI.get('Extended_Pictographic')!;
export const EMOJI_MODIFIER = EMOJI.get('Emoji_Modifier')!;
const PICTOGRAPH = EXTENDED_PICTOGRAPHIC;
const MODIFIER = EMOJI_MODIFIER;
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
// What writing needs and can't hide text with (contract §5.3): the direction marks, which can't reorder a run; private-use
// characters, which show as icons and hold no text; and a non-joiner or joiner with a character of a script that writes
// with them on each side (Arabic, Syriac and the Indic blocks), whatever that character's category.
const DIRECTION_MARKS = new Set(['\u200e', '\u200f', '\u061c']);
const PRIVATE_USE = /^[\u{e000}-\u{f8ff}\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}]$/u;
const JOINING_SCRIPT = /^[\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u08a0-\u08ff\u0900-\u0dff\ufb50-\ufdff\ufe70-\ufefe]$/u;
const inScript = (text: string, at: number, c: string) => JOINING_SCRIPT.test(pointBefore(text, at)) && JOINING_SCRIPT.test(pointAfter(text, at + c.length));
// A flag's tag sequence: U+1F3F4, then three to six tag digits or small letters (a region and subdivision code, as
// England's flag is), then the cancel tag U+E007F; a longer run can smuggle text. Given the first tag after the flag,
// where the sequence ends (0 if it isn't one); each tag is looked at once.
const TAG_BASE = 0x1f3f4;
const isTag = (c: string) => c.codePointAt(0)! >= 0xe0000 && c.codePointAt(0)! <= 0xe007f;
function flagTagsEnd(text: string, at: number): number {
  if (pointBefore(text, at).codePointAt(0) !== TAG_BASE) return 0;
  let i = at;
  for (let p = text.codePointAt(i); p !== undefined && ((p >= 0xe0030 && p <= 0xe0039) || (p >= 0xe0061 && p <= 0xe007a)); p = text.codePointAt(i)) i += 2;
  const tags = (i - at) / 2;
  return tags >= 3 && tags <= 6 && text.codePointAt(i) === 0xe007f ? i + 2 : 0;
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

// A blank, as ECMAScript's \s but with Unicode 16.0's space separators pinned rather than the runtime's: tab, line feed,
// vertical tab, form feed, carriage return, the byte-order mark, the line and paragraph separators, and the 17 Zs (all
// in the BMP, so no /u flag is needed and /i keeps its plain ASCII folding).
const BLANKS = `\\t\\n\\v\\f\\r\\ufeff\\u2028\\u2029${SPACE_SEPARATORS.map((cp) => `\\u${cp.toString(16).padStart(4, '0')}`).join('')}`;
const S = `[${BLANKS}]`;
const BLANK = new RegExp(`^${S}$`);
const isBlank = (c: string | undefined) => c !== undefined && BLANK.test(c);

// "ignore previous instructions": ignore, disregard or forget, then optionally all, any or the, then previous, prior,
// above, earlier or system, then instruction, guidance, rule, message or prompt, singular or plural.
const IGNORE = new RegExp(`\\b(?:ignore|disregard|forget)${S}+(?:(?:all|any|the)${S}+)?(?:previous|prior|above|earlier|system)${S}+(?:instruction|guidance|rule|message|prompt)s?\\b`, 'i');
// "addressed to the assistant", in three forms only: "to the <noun>:" (with its colon), "note to (the) <noun>", and
// "(the) <noun> reading this", where the noun is assistant, AI, model, LLM, agent or Claude. So "Send the diff to the
// model" and "Claude should …" aren't.
const NOUN = '(?:assistant|ai|model|llm|agent|claude)s?';
const ADDRESSED = new RegExp(`\\bto${S}+the${S}+${NOUN}${S}*:|\\bnote${S}+to${S}+(?:the${S}+)?${NOUN}\\b|\\b${NOUN}${S}+reading${S}+this\\b`, 'i');

// One word of a command from `i`: blanks skipped, then everything up to a blank or where a command ends (`|`, `;`, `&`,
// a backtick). Null when the command has ended.
const COMMAND_END = new Set(['|', ';', '&', '`']);
function nextWord(text: string, i: number): { word: string; next: number } | null {
  while (isBlank(text[i])) i++;
  const start = i;
  while (i < text.length && !isBlank(text[i]) && !COMMAND_END.has(text[i]!)) i++;
  return i > start ? { word: text.slice(start, i), next: i } : null;
}
const nameOf = (word: string) => word.slice(word.lastIndexOf('/') + 1).toLowerCase();

// "curl piped to a shell": curl or wget with at least one argument, then any later single `|` (not `||`) followed, after
// blanks of any length, by the shell: sh, bash, zsh, or python/python3 unless given a module (-m) or a script file, by
// name or path, through env (with any NAME=value settings) or through sudo with any flags and options, each word read
// whole. Or a download run through a substitution as a shell's argument or into eval, source or `.`: `sh -c "$(curl …)"`
// (blanks inside the quote too), `bash <(curl …)`, `eval "$(curl …)"`, `source <(curl …)`, backticks around the download.
const FETCHERS = /\b(?:curl|wget)\b/gi;
const NOT_AN_ARGUMENT = new Set(['|', ';', '&', '`', ')']);
const SHELL_NAME = /^(?:sh|bash|zsh)$/;
const PYTHON_NAME = /^python3?$/;
const SUDO_TAKES_VALUE = new Set(['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-T', '-U']);
const ENV_TAKES_VALUE = new Set(['-u', '-C', '-S']);
const SETTING = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Where the first curl or wget that has an argument ends, or -1. Each match's blanks are read once.
function downloadEnd(text: string): number {
  for (const m of text.matchAll(FETCHERS)) {
    let j = m.index + m[0].length;
    while (isBlank(text[j])) j++;
    if (j > m.index + m[0].length && j < text.length && !NOT_AN_ARGUMENT.has(text[j]!)) return j;
  }
  return -1;
}
// Whether the command from `i` (just after a pipe) is a shell that reads its program from the pipe.
function intoShell(text: string, i: number): boolean {
  let w = nextWord(text, i);
  if (w && nameOf(w.word) === 'sudo') {
    for (w = nextWord(text, w.next); w && w.word.startsWith('-'); w = w && nextWord(text, w.next)) if (SUDO_TAKES_VALUE.has(w.word)) w = nextWord(text, w.next);
  }
  if (w && nameOf(w.word) === 'env') {
    for (w = nextWord(text, w.next); w && (w.word.startsWith('-') || SETTING.test(w.word)); w = w && nextWord(text, w.next)) if (ENV_TAKES_VALUE.has(w.word)) w = nextWord(text, w.next);
  }
  if (!w) return false;
  const name = nameOf(w.word);
  if (SHELL_NAME.test(name)) return true;
  if (!PYTHON_NAME.test(name)) return false;
  // python reads the pipe with no arguments, `-` or -c; a module (-m) or a script file is its own program
  for (let v = nextWord(text, w.next); v; v = nextWord(text, v.next)) {
    if (v.word === '-m') return false;
    if (v.word === '-c' || v.word === '-') return true;
    if (!v.word.startsWith('-')) return false;
  }
  return true;
}
// A substitution that opens on a download, and what runs it just before (read over a short window, so still linear).
const SUBSTITUTION_OF_DOWNLOAD = /(?:\$\(|<\(|`)[ \t]*(?:curl|wget)\b/gi;
const SHELL = '(?:\\/[\\w.-]*)*\\/?(?:sh|bash|zsh|python3?)(?![\\w-])';
const RUNS_BEFORE = new RegExp(`(?:^|[^\\w/.-])(?:${SHELL}(?:${S}+-[^${BLANKS}]+)*|eval|source|\\.)${S}+(?:["']${S}*)?$`, 'i');
function curlToShell(text: string): boolean {
  const from = downloadEnd(text);
  if (from >= 0) {
    for (let at = text.indexOf('|', from); at >= 0; at = text.indexOf('|', at + 1)) {
      if (text[at + 1] === '|') {
        at++;
        continue;
      }
      if (intoShell(text, at + 1)) return true;
    }
  }
  for (const m of text.matchAll(SUBSTITUTION_OF_DOWNLOAD)) if (RUNS_BEFORE.test(text.slice(Math.max(0, m.index - 80), m.index))) return true;
  return false;
}

// "sends a local file or variable": curl, wget or nc with a data option (-d, --data…, --json, -F, --form,
// --upload-file, -T, those letters inside a cluster such as -sd or -sT, and wget's --post-data and --post-file) naming a
// home path or a variable ($…, ~/…, .ssh, .aws, .env), or with a command substitution ($(…) or backticks) in its URL or
// the value of -H/--header. Only within that command: it ends at a `|`, a `;` or a `&&` outside quotes, or at the
// backtick that closes the code span it sits in, never in a later word of the sentence.
const SENDERS = /\b(?:curl|wget|nc)\b/gi;
const LOCAL = /\$|~\/|\.ssh|\.aws|\.env/;
const COMMAND_SUBSTITUTION = /\$\(|`[\w$]/;
const DATA_OPTIONS = new Set(['--data', '--data-raw', '--data-binary', '--data-urlencode', '--data-ascii', '--json', '--form', '--form-string', '--upload-file', '--post-data', '--post-file']);
const HEADER_OPTIONS = new Set(['--header']);
const VALUE_LETTERS = new Set([...'AbcCDeEKmoPQrtuUwxXyYz']); // curl's other short options that take a value
// A command's words from `from`: runs of anything but blanks, a quoted part kept whole (so a quoted header is one word),
// up to where the command ends. Each character is read once.
function commandWords(text: string, from: number, inSpan: boolean): { words: string[]; end: number } {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let i = from;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      word += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '|' || c === ';' || (c === '&' && text[i + 1] === '&') || (c === '`' && inSpan)) break;
    if (isBlank(c)) {
      if (word) words.push(word);
      word = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    word += c;
  }
  if (word) words.push(word);
  return { words, end: i };
}
// What option the word at `k` is, if it's a data or header option, and its value (the rest of the word, or the next).
function optionAt(words: readonly string[], k: number): { kind: 'data' | 'header'; value: string | undefined } | null {
  const w = words[k]!;
  if (w.startsWith('--')) {
    const eq = w.indexOf('=');
    const name = eq < 0 ? w : w.slice(0, eq);
    const kind = DATA_OPTIONS.has(name) ? 'data' : HEADER_OPTIONS.has(name) ? 'header' : null;
    return kind && { kind, value: eq < 0 ? words[k + 1] : w.slice(eq + 1) };
  }
  if (!w.startsWith('-')) return null;
  for (let j = 1; j < w.length; j++) {
    const c = w[j]!;
    const kind = c === 'd' || c === 'F' || c === 'T' ? 'data' : c === 'H' ? 'header' : null;
    if (kind) return { kind, value: j + 1 < w.length ? w.slice(j + 1) : words[k + 1] };
    if (VALUE_LETTERS.has(c) || !/[A-Za-z]/.test(c)) return null;
  }
  return null;
}
function sendsLocal(text: string): boolean {
  let pos = 0;
  for (const m of text.matchAll(SENDERS)) {
    if (m.index < pos) continue;
    let b = m.index - 1;
    while (b >= pos && isBlank(text[b])) b--;
    const { words, end } = commandWords(text, m.index + m[0].length, b >= pos && text[b] === '`');
    pos = end;
    for (let k = 0; k < words.length; k++) {
      const option = optionAt(words, k);
      if (option?.kind === 'data' && option.value !== undefined && LOCAL.test(option.value)) return true;
      if (option?.kind === 'header' && option.value !== undefined && COMMAND_SUBSTITUTION.test(option.value)) return true;
      if (words[k]!.includes('://') && COMMAND_SUBSTITUTION.test(words[k]!)) return true;
    }
  }
  return false;
}

// Markdown's link-reference comment: `[<any label>]: #` then `(…)`, `"…"` or `'…'`, or `[<any label>]: <> (…)`, holding
// letters: a line that renders as nothing.
const LINK_COMMENT = /^[ \t]*\[[^\]]*\]:[ \t]*(?:#[ \t]*(?:\(([^)]*)\)|"([^"]*)"|'([^']*)')|<>[ \t]*\(([^)]*)\))/;
const hiddenLinkComment = (text: string) => {
  const m = LINK_COMMENT.exec(text);
  return m !== null && LETTER.test(m[1] ?? m[2] ?? m[3] ?? m[4] ?? '');
};

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
