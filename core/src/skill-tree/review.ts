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
const BLANK_SET = new Set(['\t', '\n', '\v', '\f', '\r', String.fromCharCode(0xfeff, 0x2028, 0x2029).split(''), SPACE_SEPARATORS.map((cp) => String.fromCharCode(cp))].flat());
const isBlank = (c: string | undefined) => c !== undefined && BLANK_SET.has(c);

// "ignore previous instructions": ignore, disregard or forget, then optionally all, any or the, then previous, prior,
// above, earlier or system, then instruction, guidance, rule, message or prompt, singular or plural.
const IGNORE = new RegExp(`\\b(?:ignore|disregard|forget)${S}+(?:(?:all|any|the)${S}+)?(?:previous|prior|above|earlier|system)${S}+(?:instruction|guidance|rule|message|prompt)s?\\b`, 'i');
// "addressed to the assistant", in three forms only: "to the <noun>:" (with its colon), "note to (the) <noun>", and
// "(the) <noun> reading this", where the noun is assistant, AI, model, LLM, agent or Claude. So "Send the diff to the
// model" and "Claude should …" aren't.
const NOUN = '(?:assistant|ai|model|llm|agent|claude)s?';
const ADDRESSED = new RegExp(`\\bto${S}+the${S}+${NOUN}${S}*:|\\bnote${S}+to${S}+(?:the${S}+)?${NOUN}\\b|\\b${NOUN}${S}+reading${S}+this\\b`, 'i');

// ---------- commands, as a shell would read them (contract §5.3) ----------
//
// A line is read left to right into commands. A command word counts only where a shell would read one: at the start of
// the line or of a code span, after `|`, `|&`, `||`, `;`, `&` or `&&`, at the start of a `$( … )`, `<( … )` or backtick
// substitution, and inside a subshell's `( … )` or a group's `{ …; }`; sudo and env are looked past with their options and
// settings. A subshell or group is one command on either side of a pipe: a download in it is piped, and one opened right
// after a pipe starts with that pipe. A command runs to the next of those, or to the end of its span, substitution,
// subshell or group; on the line itself (prose, or a line of
// a code block) a backtick ends it too, so prose never reaches into a later code span, and a span's closing backtick
// always ends the span, whatever quote or backslash it holds. `>&`, `<&` and `&>` are redirections, not a lone `&`.
// A quote that opens a word (or follows `=`) keeps it whole; a quote inside a word, as in "don't", is text, so an
// apostrophe can't hide the rest of a line. A quote in prose is text too, and a rule can't tell prose from a command, so
// each line is read twice: with the quotes on the line itself kept, and with them read as text (inside a span or a
// substitution a quote is always kept); a flag from either reading counts. A substitution inside a word is read as its
// own commands and marks the word when it runs a download, at any depth. Substitutions and subshells nest at most
// MAX_NESTING deep (deeper, an opener is text), so each character is read a bounded number of times in each reading.
const MAX_NESTING = 8;
type FrameKind = 'line' | 'subshell' | 'group' | 'span' | 'dollar' | 'process' | 'tick';
interface Word {
  start: number;
  end: number;
  download: boolean; // holds a substitution that runs a download
}
interface Frame {
  kind: FrameKind;
  words: Word[];
  word: Word | null;
  quote: '' | '"' | "'";
  afterPipe: boolean; // this command is fed by a pipe
  pipedDownload: boolean; // a download ran earlier in this pipeline
  downloads: boolean; // a command in this frame is a download (for the word holding the substitution)
  carries: boolean; // a word in this frame holds a substitution that runs a download (for a download at any depth)
  fetched: boolean; // a command in this frame, or in a subshell or group inside it, holds a download (for the pipe after)
  groupFetched: boolean; // a subshell or group in the command read so far held a download: it is piped as the command's
  prose: boolean; // this command follows a code span on the line: its first word isn't at a command start
  firstArg: number | undefined; // where a shell's first argument was found for this command, once a backtick asked
}
// The line itself, a subshell and a group read backticks and (in the second reading) quotes as the line does.
const lineLike = (f: Frame) => f.kind === 'line' || f.kind === 'subshell' || f.kind === 'group';
interface Command {
  words: string[];
  download: boolean[];
}

const BLANK_RUN = new RegExp(`${S}+`);
const QUOTING = /["'\\]/;
const unquote = (word: string) => (QUOTING.test(word) ? word.replace(/["'\\]/g, '') : word);
const nameOf = (word: string) => {
  const w = unquote(word);
  return w.slice(w.lastIndexOf('/') + 1).toLowerCase();
};
const SETTING = /^[A-Za-z_][A-Za-z0-9_]*=/;
const FETCH_NAMES = new Set(['curl', 'wget']);
const SHELL_NAME = /^(?:sh|bash|zsh)$/;
const PYTHON_NAME = /^python3?$/;
const SOURCING = new Set(['eval', 'source', '.']);
const SUDO_SHORT_VALUE = new Set([...'ugCDhprtTUR']);
const SUDO_LONG_VALUE = new Set(['--user', '--group', '--close-from', '--chdir', '--host', '--prompt', '--role', '--type', '--command-timeout', '--other-user', '--chroot']);
const ENV_SHORT_VALUE = new Set([...'uCS']);
const ENV_LONG_VALUE = new Set(['--unset', '--chdir', '--split-string']);

// The command's own word, past sudo and env with their options and settings (and NAME=value before it): the words and
// its index. env -S's string holds the command, so it's read as the words.
function commandOf(words: readonly string[]): { words: readonly string[]; at: number } | null {
  let k = 0;
  while (k < words.length) {
    const w = unquote(words[k]!);
    if (SETTING.test(w)) {
      k++;
      continue;
    }
    const name = nameOf(w);
    if (name !== 'sudo' && name !== 'env') return { words, at: k };
    const [short, long] = name === 'sudo' ? [SUDO_SHORT_VALUE, SUDO_LONG_VALUE] : [ENV_SHORT_VALUE, ENV_LONG_VALUE];
    for (k++; k < words.length; k++) {
      const o = unquote(words[k]!);
      if (o === '--') {
        k++;
        break;
      }
      if (o === '-' || SETTING.test(o)) continue;
      if (!o.startsWith('-')) break;
      // the option's value: after `=`, the rest of a short cluster, or the next word
      let option = o;
      let value: string | undefined;
      let next = false;
      if (o.startsWith('--')) {
        const eq = o.indexOf('=');
        option = eq < 0 ? o : o.slice(0, eq);
        if (long.has(option)) {
          if (eq < 0) next = true;
          else value = o.slice(eq + 1);
        }
      } else {
        for (let j = 1; j < o.length; j++) {
          if (!short.has(o[j]!)) continue;
          option = `-${o[j]}`;
          if (j + 1 < o.length) value = o.slice(j + 1);
          else next = true;
          break;
        }
      }
      if (next) value = k + 1 < words.length ? unquote(words[++k]!) : undefined;
      if (name === 'env' && (option === '-S' || option === '--split-string') && value !== undefined) {
        return commandOf(value.split(BLANK_RUN).filter(Boolean));
      }
    }
  }
  return null;
}
const commandName = (words: readonly string[]) => {
  const c = commandOf(words);
  return c && { ...c, name: nameOf(c.words[c.at]!) };
};

// A shell that reads its program from the pipe: sh, bash, zsh, or python with no script and no module (-c or - counts).
type Resolved = { words: readonly string[]; at: number; name: string } | null;
// The name is read without the punctuation ending a sentence ("… | bash.", "… | sh!", "… | bash…", "… | bash。") or a
// closing parenthesis ("(… | bash)" in prose).
const SENTENCE_END = /[.,;:!?)\u2026\u3002]+$/;
function readsPipe(c: Resolved): boolean {
  if (!c) return false;
  const name = c.name.replace(SENTENCE_END, '');
  if (SHELL_NAME.test(name)) return true;
  if (!PYTHON_NAME.test(name)) return false;
  for (let k = c.at + 1; k < c.words.length; k++) {
    const w = unquote(c.words[k]!);
    if (w === '-m') return false;
    if (w === '-c' || w === '-') return true;
    if (!w.startsWith('-')) return false;
  }
  return true;
}
// Where a command runs what a substitution in its word gives it: a shell's or python's first argument that isn't an
// option (after -c, past an option's value: `bash -o pipefail -c "$(curl …)"`, `python <(curl …)`), eval's, source's or
// .'s first argument, and the word a `<` feeds it (`bash < <(curl …)`). Not a later argument (`bash deploy.sh "$(curl …)"`
// hands the script a value), and not python's with -m. With env -S the command sits inside one word, so any word counts.
// At a command start that's the command's own word; a shell's or python's also counts anywhere, prose included, as the pipe
// does ("To install, run /bin/bash -c "$(curl …)""), each read up to the next such word, so a word is read once.
const SHELL_VALUE = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const PYTHON_VALUE = new Set(['-W', '-X', '-Q']);
const FED = /^[0-9]*<$/;
// The words a command named `name` at `at` runs, read up to `stop`, added to `out`.
function runsFrom(words: readonly string[], at: number, name: string, stop: number, out: number[]): void {
  const shell = SHELL_NAME.test(name);
  const python = PYTHON_NAME.test(name);
  if (!shell && !python && !SOURCING.has(name)) return;
  let first = false;
  let options = true;
  for (let k = at + 1; k < stop; k++) {
    const w = unquote(words[k]!);
    if (FED.test(w)) {
      if (k + 1 < stop) out.push(k + 1);
      k++;
      continue;
    }
    if (first) continue;
    if (options && !SOURCING.has(name) && (w.startsWith('-') || (shell && w.startsWith('+'))) && w.length > 1) {
      if (w === '--') options = false;
      else if (python && w === '-m') first = true;
      else if ((shell && SHELL_VALUE.has(w)) || (python && PYTHON_VALUE.has(w))) k++;
      continue;
    }
    out.push(k);
    first = true;
  }
}
function runPositions(words: readonly string[]): number[] {
  const c = commandName(words);
  if (!c) return [];
  if (c.words !== words) return SHELL_NAME.test(c.name) || PYTHON_NAME.test(c.name) || SOURCING.has(c.name) ? words.map((_, k) => k) : [];
  const out: number[] = [];
  runsFrom(words, c.at, c.name, words.length, out);
  return out;
}
// A shell's or python's words anywhere in the command, each read up to the next shell or python word.
const shellLike = (name: string) => SHELL_NAME.test(name) || PYTHON_NAME.test(name);
function anywherePositions(words: readonly string[], names: readonly string[]): number[] {
  const starts: number[] = [];
  names.forEach((n, k) => {
    if (shellLike(n)) starts.push(k);
  });
  const out: number[] = [];
  starts.forEach((at, j) => runsFrom(words, at, names[at]!, starts[j + 1] ?? words.length, out));
  return out;
}
// Whether a word about to start at the end of these words is one a substitution would run in.
const runsNext = (words: readonly string[]) => runPositions([...words, 'x']).includes(words.length);

// A curl or wget with at least one argument, anywhere in the command (the pipe rule reads prose too).
const hasDownload = (names: readonly string[]) => names.some((n, k) => k + 1 < names.length && FETCH_NAMES.has(n));
// A curl or wget command with at least one argument.
const isDownload = (c: Resolved) => c !== null && FETCH_NAMES.has(c.name) && c.at + 1 < c.words.length;

// "sends a local file or variable": a curl, wget or nc word anywhere in a command (prose too), then its own data option
// naming a home path or a variable, or a command substitution in its URL (the first word that isn't an option or an
// option's value) or its header's value. Each tool's options as it spells them; a value is its whole word. A tool's words
// run to the next tool word, so each word is read once.
const LOCAL = /\$|~\/|\/home\/|\/users\/|\.ssh|\.aws|\.env/i;
const SUBSTITUTION = /\$\(|`/;
const CURL_SHORT_VALUE = new Set([...'AbcCDeEKmoPQrtuUwxXyYz']);
const CURL_LONG_VALUE = new Set(['--user', '--user-agent', '--referer', '--output', '--output-dir', '--request', '--cookie', '--cookie-jar', '--proxy', '--proxy-user', '--cert', '--key', '--cacert', '--capath', '--config', '--connect-timeout', '--max-time', '--retry', '--write-out', '--range', '--resolve', '--connect-to', '--interface', '--limit-rate', '--max-filesize', '--netrc-file', '--oauth2-bearer', '--proto', '--proto-redir', '--dump-header', '--unix-socket', '--variable', '--expand-url']);
const WGET_SHORT_VALUE = new Set([...'OoaPtTweilDUQARB']);
const WGET_LONG_VALUE = new Set(['--output-document', '--output-file', '--append-output', '--directory-prefix', '--tries', '--timeout', '--wait', '--input-file', '--level', '--domains', '--user-agent', '--user', '--password', '--method', '--referer', '--load-cookies', '--save-cookies', '--accept', '--reject', '--base']);
const WGET_DATA = ['--post-data', '--post-file', '--body-data', '--body-file'];
type OptionKind = 'data' | 'header' | 'url' | 'other' | null;
// A tool's options: what each long option or short cluster is, and its value.
function sendsWith(args: readonly string[], long: (name: string) => OptionKind, short: (cluster: string) => { kind: OptionKind; at: number }): boolean {
  let url: string | undefined;
  for (let k = 0; k < args.length; k++) {
    const raw = args[k]!;
    const o = unquote(raw);
    let kind: OptionKind = null;
    let value: string | undefined;
    if (o.startsWith('--') && o.length > 2) {
      const eq = o.indexOf('=');
      kind = long(eq < 0 ? o : o.slice(0, eq));
      if (kind && eq >= 0) value = raw.slice(raw.indexOf('=') + 1);
      else if (kind) value = args[++k];
    } else if (o.startsWith('-') && o.length > 1) {
      const s = short(o);
      kind = s.kind;
      if (kind && s.at + 1 < o.length) value = o.slice(s.at + 1);
      else if (kind) value = args[++k];
    } else if (url === undefined) {
      url = raw;
      if (SUBSTITUTION.test(raw)) return true;
      continue;
    }
    if (value === undefined) continue;
    if (kind === 'data' && LOCAL.test(value)) return true;
    if ((kind === 'header' || kind === 'url') && SUBSTITUTION.test(value)) return true;
    if (kind === 'url') url ??= value;
  }
  return false;
}
const curlLong = (name: string): OptionKind =>
  /^--data/.test(name) || /^--form/.test(name) || name === '--json' || name === '--upload-file' ? 'data' : name === '--header' ? 'header' : name === '--url' ? 'url' : CURL_LONG_VALUE.has(name) ? 'other' : null;
// curl's d, F and T anywhere in a cluster are data (after any other option characters: -sd, -4d, -#d, -0F), H a header;
// an option that takes a value ends the cluster, so letters in its attached value (-uadmin:$P, -o./build/$V.tgz) are its
// value, never options.
function curlShort(cluster: string): { kind: OptionKind; at: number } {
  for (let j = 1; j < cluster.length; j++) {
    const o = cluster[j]!;
    if (o === 'd' || o === 'F' || o === 'T') return { kind: 'data', at: j };
    if (o === 'H') return { kind: 'header', at: j };
    if (CURL_SHORT_VALUE.has(o)) return { kind: 'other', at: j };
  }
  return { kind: null, at: 0 };
}
// wget's data options, and any abbreviation of them down to --post- or --body-.
const wgetLong = (name: string): OptionKind =>
  (name.startsWith('--post-') || name.startsWith('--body-')) && WGET_DATA.some((full) => full.startsWith(name))
    ? 'data'
    : name === '--header'
      ? 'header'
      : WGET_LONG_VALUE.has(name)
        ? 'other'
        : null;
function wgetShort(cluster: string): { kind: OptionKind; at: number } {
  for (let j = 1; j < cluster.length; j++) if (WGET_SHORT_VALUE.has(cluster[j]!)) return { kind: 'other', at: j };
  return { kind: null, at: 0 };
}
// nc's input redirected from a file: `< path` or `<path`.
function ncSends(args: readonly string[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const o = unquote(args[k]!);
    const from = o === '<' ? args[k + 1] : o.startsWith('<') && !o.startsWith('<(') ? o.slice(1) : undefined;
    if (from !== undefined && LOCAL.test(from)) return true;
  }
  return false;
}
const SENDER_NAMES = new Set(['curl', 'wget', 'nc']);
function sends(words: readonly string[], names: readonly string[]): boolean {
  let tool = '';
  let from = 0;
  const check = (to: number) => {
    const args = words.slice(from, to);
    return tool === 'curl' ? sendsWith(args, curlLong, curlShort) : tool === 'wget' ? sendsWith(args, wgetLong, wgetShort) : tool === 'nc' && ncSends(args);
  };
  for (let k = 0; k < words.length; k++) {
    const name = names[k]!;
    if (!SENDER_NAMES.has(name)) continue;
    if (tool && check(k)) return true;
    tool = name;
    from = k + 1;
  }
  return tool !== '' && check(words.length);
}

// Reads a line's commands: `pipe` when a download is piped into a shell or run through a substitution by a shell, eval,
// source or `.`; `send` when a curl, wget or nc command sends a local file or variable. Both readings (above) count.
const ANY_TOOL = /\b(?:curl|wget|nc)\b/i;
function commandFlags(text: string): { pipe: boolean; send: boolean } {
  // both rules need a download or a sender somewhere on the line, however its name is quoted or escaped (c\url, "cu"rl):
  // without one there's nothing to read
  if (!ANY_TOOL.test(text.replace(/["'\\]/g, ''))) return { pipe: false, send: false };
  const kept = readCommands(text, false);
  if (kept.pipe && kept.send) return kept;
  const asText = readCommands(text, true);
  return { pipe: kept.pipe || asText.pipe, send: kept.send || asText.send };
}
function readCommands(text: string, quotesAsText: boolean): { pipe: boolean; send: boolean } {
  const out = { pipe: false, send: false };
  const frame = (kind: FrameKind): Frame => ({ kind, words: [], word: null, quote: '', afterPipe: false, pipedDownload: false, downloads: false, carries: false, fetched: false, groupFetched: false, prose: false, firstArg: undefined });
  const stack: Frame[] = [frame('line')];
  const top = () => stack[stack.length - 1]!;
  const startWord = (f: Frame, i: number) => {
    f.word ??= { start: i, end: i, download: false };
  };
  const endWord = (f: Frame, i: number) => {
    if (!f.word) return;
    f.word.end = i;
    f.words.push(f.word);
    f.word = null;
  };
  // A command ends: its checks run, and `pipe` says whether a pipe carries its output into the next one.
  const endCommand = (f: Frame, i: number, pipe: boolean) => {
    endWord(f, i);
    const words = f.words.map((w) => text.slice(w.start, w.end));
    let fetched = f.groupFetched;
    if (words.length) {
      const cmd: Command = { words, download: f.words.map((w) => w.download) };
      const c = f.prose ? null : commandName(cmd.words);
      if (f.afterPipe && f.pipedDownload && readsPipe(c)) out.pipe = true;
      const names = words.map(nameOf);
      if (cmd.download.some(Boolean)) {
        const runs = (k: number) => cmd.download[k];
        if ((c && runPositions(cmd.words).some(runs)) || anywherePositions(cmd.words, names).some(runs)) out.pipe = true;
      }
      if (!out.send && sends(cmd.words, names)) out.send = true;
      if (isDownload(c)) f.downloads = true;
      fetched ||= hasDownload(names);
    }
    if (fetched) f.fetched = true;
    f.pipedDownload = pipe && (f.pipedDownload || fetched);
    f.groupFetched = false;
    f.afterPipe = pipe;
    f.words = [];
    f.prose = false;
    f.firstArg = undefined;
  };
  // Whether a backtick on the line (or in a subshell) opens a substitution: only in the word a shell, python, eval,
  // source or . would run. The command's words are read at the first such backtick and the answer kept for the command
  // (a backtick anywhere else ends it), so each word is read a bounded number of times.
  const runsBacktick = (f: Frame) => {
    const at = f.words.length;
    if (f.firstArg === undefined) {
      if (f.prose || !runsNext(f.words.map((w) => text.slice(w.start, w.end)))) return false;
      f.firstArg = at;
    }
    return f.firstArg === at;
  };
  const open = (kind: FrameKind, i: number) => {
    startWord(top(), i);
    stack.push(frame(kind));
  };
  const close = (i: number) => {
    const f = stack.pop()!;
    endCommand(f, i, false);
    const parent = top();
    // a substitution's download, at any depth, marks the word holding it
    if ((f.kind === 'dollar' || f.kind === 'process' || f.kind === 'tick') && (f.downloads || f.carries) && parent.word) {
      parent.word.download = true;
      parent.carries = true;
    }
    // a subshell or group is one command on either side of a pipe: a download in it is piped
    if ((f.kind === 'subshell' || f.kind === 'group') && f.fetched) parent.groupFetched = true;
    // what follows a code span on the line, or a subshell's ) or a group's }, isn't at a command start (the contract's
    // starts don't include it), so "(macOS only). `curl …`" has no `.` command
    if (f.kind === 'span' || f.kind === 'subshell' || f.kind === 'group') parent.prose = true;
  };
  // A subshell or group opened where a command would start, right after a pipe, starts with that pipe.
  const openGroup = (kind: 'subshell' | 'group') => {
    const parent = top();
    const g = frame(kind);
    if (!parent.words.length) {
      g.afterPipe = parent.afterPipe;
      g.pipedDownload = parent.pipedDownload;
    }
    stack.push(g);
  };
  for (let i = 0; i < text.length; i++) {
    const f = top();
    const c = text[i]!;
    // a span's closing backtick always ends it, whatever quote or backslash came before
    if (f.kind === 'span' && c === '`') {
      close(i);
      continue;
    }
    if (f.quote === "'") {
      if (c === "'") f.quote = '';
      continue;
    }
    // a backslash escapes the next character, except in a span, whose closing backtick nothing escapes
    if (c === '\\' && f.kind !== 'span') {
      startWord(f, i);
      i++;
      continue;
    }
    const room = stack.length <= MAX_NESTING;
    if (f.quote === '"') {
      if (c === '"') f.quote = '';
      else if (room && c === '$' && text[i + 1] === '(') {
        open('dollar', i);
        i++;
      } else if (room && c === '`') open('tick', i);
      continue;
    }
    if (c === "'" || c === '"') {
      if ((!f.word || text[i - 1] === '=') && !(quotesAsText && lineLike(f))) f.quote = c;
      startWord(f, i);
      continue;
    }
    if (c === '`') {
      // A substitution's own backtick closes it; inside one a backtick opens one. On the line or in a subshell, a
      // backtick in the word a command would run (a shell's first argument, eval's …) opens a backtick substitution in
      // it, as the shell reads `bash -c `curl …``; anywhere else it ends the command and opens a code span.
      if (f.kind === 'tick') close(i);
      else if (!lineLike(f)) {
        if (room) open('tick', i);
        else startWord(f, i);
      } else if (room && runsBacktick(f)) open('tick', i);
      else {
        endCommand(f, i, false);
        if (room) stack.push(frame('span'));
      }
      continue;
    }
    if (room && (c === '$' || c === '<') && text[i + 1] === '(') {
      open(c === '$' ? 'dollar' : 'process', i);
      i++;
      continue;
    }
    // a subshell's ( at the start of a word, or a group's { as a word of its own: their commands start inside them
    if (room && c === '(' && !f.word) {
      openGroup('subshell');
      continue;
    }
    if (room && c === '{' && !f.word && (i + 1 === text.length || isBlank(text[i + 1]))) {
      openGroup('group');
      continue;
    }
    if (c === ')' && (f.kind === 'dollar' || f.kind === 'process' || f.kind === 'subshell')) {
      close(i);
      continue;
    }
    // a group's } as a word of its own closes it
    if (c === '}' && f.kind === 'group' && !f.word && (i + 1 === text.length || isBlank(text[i + 1]) || ';|&)'.includes(text[i + 1]!))) {
      close(i);
      continue;
    }
    if (isBlank(c)) {
      endWord(f, i);
      continue;
    }
    if (c === '|') {
      if (text[i + 1] === '|') {
        endCommand(f, i, false);
        i++;
      } else {
        endCommand(f, i, true);
        if (text[i + 1] === '&') i++;
      }
      continue;
    }
    // >&, <& and &> redirect: the & is part of the word, not a command's end
    if (c === '&' && (text[i - 1] === '>' || text[i - 1] === '<' || text[i + 1] === '>')) {
      startWord(f, i);
      continue;
    }
    if (c === ';' || c === '&') {
      endCommand(f, i, false);
      if (c === '&' && text[i + 1] === '&') i++;
      continue;
    }
    startWord(f, i);
  }
  while (stack.length > 1) close(text.length);
  endCommand(top(), text.length, false);
  return out;
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
  const commands = commandFlags(text);
  if (commands.pipe) return 'curl piped to a shell';
  if (commands.send) return 'sends a local file or variable';
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
