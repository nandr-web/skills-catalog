// What changed between two versions of a skill, and the update gate's risk flags from that change (contract §2 diff,
// §5.3). The rules reviewer's own flags (prompt injection, context cost) join these in the reviewer, not here.

import { CatalogError } from './errors.ts';
import { MANIFEST, parseFrontmatter } from './manifest.ts';
import { INVISIBLE, decodeText, isText, type Mode, type TreeFile } from './tree.ts';

// Flag text (a path, a change's sides, the detail) can carry a publisher's text, so it is plain text in the flag
// itself (contract §5.3): an invisible character becomes \u{XXXX}, then the text is cut to 200 code points, ending in
// "…" within the 200. Every face shows the same; applying it twice changes nothing.
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'gu');
export const FLAG_TEXT_MAX = 200;
export function flagText(text: string): string {
  const escaped = [...text.replace(INVISIBLE_ALL, (c) => `\\u{${c.codePointAt(0)!.toString(16)}}`)];
  return escaped.length <= FLAG_TEXT_MAX ? escaped.join('') : escaped.slice(0, FLAG_TEXT_MAX - 1).join('') + '…';
}
const flagValue = (v: unknown) => (typeof v === 'string' ? flagText(v) : v);

export type RiskKind =
  | 'runnable_file'
  | 'runs_at_load'
  | 'command_instruction'
  | 'capability_frontmatter'
  | 'instructions_changed'
  | 'non_markdown'
  | 'new_publisher'
  | 'prompt_injection'
  | 'context_cost';

// One reason the gate would hold, in one shape everywhere (contract §5.3). A change carries its sides as data
// (`field`, `from`, `to`), so nothing has to parse `detail`.
export interface RiskFlag {
  kind: RiskKind;
  path?: string;
  line?: number;
  field?: string;
  from?: unknown;
  to?: unknown;
  detail: string;
}

export interface FileFlags {
  binary: boolean;
  executable: boolean;
  script: boolean;
}

export interface FileChange {
  path: string;
  status: 'added' | 'changed' | 'removed';
  flags: FileFlags;
  unified?: string;
}

export interface TreeDiff {
  files: FileChange[];
  frontmatter_changes: { field: string; from: unknown; to: unknown }[];
  publisher_changed: boolean;
  risk_flags: RiskFlag[];
}

// One side of a diff: a version's files and who published it. `null` for "no version yet" (a new skill).
export interface DiffSide {
  files: readonly TreeFile[];
  publisher: string;
  label?: string;
}

// Front matter keys that can't make anything run without a prompt (contract §5.3, config: safe_frontmatter_keys). Every
// other key counts as granting capability (allowed-tools, hooks, context, agent, shell, model, and any key Claude Code
// adds later), so a change to it is a risk flag: the gate fails closed.
export const DEFAULT_SAFE_FRONTMATTER_KEYS: readonly string[] = [
  'name',
  'description',
  'when_to_use',
  'argument-hint',
  'arguments',
  'license',
  'compatibility',
  'metadata',
  'version',
  'tags',
];

// Front matter keys known to grant nothing (contract §5.3, non_granting_keys): with only these, a changed file is no
// reason to ask. A change to one is still its own capability_frontmatter flag.
export const DEFAULT_NON_GRANTING_KEYS: readonly string[] = ['model', 'effort', 'disable-model-invocation', 'user-invocable', 'paths', 'disallowed-tools'];

const SCRIPT_EXT = /\.(sh|bash|zsh|fish|ksh|py|js|mjs|cjs|ts|mts|cts|rb|pl|php|ps1|psm1|bat|cmd|exe|com|jar|lua|tcl|applescript|scpt)$/i;
const MARKDOWN_EXT = /\.(md|markdown)$/i;

export function fileFlags(f: TreeFile): FileFlags {
  const binary = !isText(f.bytes);
  const executable = f.mode === '0755';
  const shebang = f.bytes.length >= 2 && f.bytes[0] === 0x23 && f.bytes[1] === 0x21;
  return { binary, executable, script: SCRIPT_EXT.test(f.path) || shebang };
}

export function isMarkdown(path: string): boolean {
  return MARKDOWN_EXT.test(path);
}

// The gate's reason for one added or changed file, if any: one reason per file, runnable_file over non_markdown.
export function fileRisk(f: TreeFile): RiskFlag | null {
  const flags = fileFlags(f);
  if (flags.executable || flags.script) {
    const detail = flags.executable && flags.script ? 'executable script' : flags.executable ? 'executable' : 'script';
    return { kind: 'runnable_file', path: f.path, detail };
  }
  if (isMarkdown(f.path)) return null;
  const ext = /\.([^./]+)$/.exec(f.path)?.[1];
  return { kind: 'non_markdown', path: f.path, detail: ext ? `.${ext} file` : 'file with no extension' };
}

// An injected command (contract §5.3): Claude Code runs `!` + a backtick-quoted command, and a ```! block, as the skill
// loads. The detector is wider than Claude Code's rule, so no spelling slips past: a `!` right before a backtick anywhere
// in a markdown file (front matter, code blocks and comments included), and a block whose opening line starts, after
// blanks, with three or more backticks or tildes, then blanks, then `!`. A block is one command, at its opening line, and
// its text is the whole block, so an edit inside it counts; an inline one's text is its line.
export interface Injection {
  line: number;
  text: string;
  command: string;
}
// Lines end at LF, CR, U+2028 or U+2029 (a CRLF is one break); the blanks before a fence and between it and its `!` are
// spaces, tabs and the invisible set (a no-break space, a zero-width character, a byte-order mark), so no spelling slips
// past (contract §5.3).
// A fence is read with a plain loop over code points, never a pattern: the blanks overlap (a tab is also invisible), and
// a pattern over them would backtrack without end on a line of tabs that isn't a fence.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const ONE_INVISIBLE = new RegExp(`^(?:${INVISIBLE.source})$`, 'u');
// Every line inside an open block is read for an opening fence, so a line of invisible characters must stay cheap: the
// pattern's answer for each character under U+10000 is kept (0 not asked yet, 1 blank, 2 not).
const BMP_BLANK = new Uint8Array(0x10000);
function isBlankPoint(code: number): boolean {
  if (code >= 0x10000) return ONE_INVISIBLE.test(String.fromCodePoint(code));
  if (!BMP_BLANK[code]) BMP_BLANK[code] = ONE_INVISIBLE.test(String.fromCharCode(code)) ? 1 : 2;
  return BMP_BLANK[code] === 1;
}
function skipBlanks(line: string, i: number): number {
  while (i < line.length) {
    const code = line.codePointAt(i)!;
    if (code === 0x20 || code === 0x09) {
      i++;
      continue;
    }
    if (code < 0x7f && code > 0x20) break;   // a printable ASCII character is never blank
    if (!isBlankPoint(code)) break;
    i += code >= 0x10000 ? 2 : 1;
  }
  return i;
}
type Fence = { char: string; length: number };
// A line that opens a ```! or ~~~! block: blanks, three or more of one fence character, blanks, then `!`.
function openingFence(line: string): Fence | null {
  if (!line.includes('`') && !line.includes('~')) return null;
  const i = skipBlanks(line, 0);
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  const length = countRun(line, i, char);
  if (length < 3) return null;
  return line[skipBlanks(line, i + length)] === '!' ? { char, length } : null;
}
const countRun = (line: string, from: number, char: string) => {
  let n = 0;
  while (line[from + n] === char) n++;
  return n;
};
// A line that closes, strictly (so an edit after a doubtful close still counts as inside): up to three spaces, a run of
// one fence character, then only spaces or tabs to the line's end. It closes every open block of that character that is
// no longer than the run.
function closingFence(line: string): Fence | null {
  let i = 0;
  while (i < 3 && line[i] === ' ') i++;
  const char = line[i];
  if (char !== '`' && char !== '~') return null;
  const length = countRun(line, i, char);
  if (length < 3) return null;
  for (i += length; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return null;
  return { char, length };
}
// The first `max` code points of a string, and whether it was cut: a cut never splits a surrogate pair.
function cut(s: string, max: number): { text: string; points: number; cut: boolean } {
  let i = 0;
  let points = 0;
  while (i < s.length && points < max) {
    i += s.codePointAt(i)! > 0xffff ? 2 : 1;
    points++;
  }
  return { text: s.slice(0, i), points, cut: i < s.length };
}
// A flag's detail shows the whole command, its lines or commands joined by a visible mark (then flagText cuts it). The
// command is collected only up to one code point past the cut, so flagText still sees that it's longer.
const JOIN = ' ⏎ ';
const JOIN_POINTS = [...JOIN].length;
function joined(parts: Iterable<string>): string {
  const out: string[] = [];
  let n = 0;
  for (const p of parts) {
    if (n > FLAG_TEXT_MAX) break;
    const c = cut(p.trim(), FLAG_TEXT_MAX + 1 - n);
    if (!c.text) continue;
    out.push(c.text);
    n += c.points + JOIN_POINTS;
  }
  return out.join(JOIN);
}
function* inlineCommands(line: string): Generator<string> {
  for (let at = line.indexOf('!`'); at >= 0; at = line.indexOf('!`', at + 2)) {
    const end = line.indexOf('`', at + 2);
    yield line.slice(at + 2, end < 0 ? undefined : end);
    if (end < 0) return;
    at = end - 1;
  }
}
function* linesOf(lines: readonly string[], from: number, to: number): Generator<string> {
  for (let k = from; k < to; k++) yield lines[k]!;
}
// More blocks open at once than this, and the file is read as one block from the first opening line: any edit to it
// counts (the detector errs toward asking), and every line is still read a bounded number of times.
const MAX_OPEN = 8;
export function injections(text: string): Injection[] {
  const lines = text.split(LINE_BREAK);
  const out: Injection[] = [];
  // The blocks not closed yet, oldest first; each fills in its injection when it closes (or at the end of the file).
  let open: { fence: Fence; at: number; injection: Injection }[] = [];
  const close = (b: (typeof open)[number], end: number) => {
    b.injection.text = lines.slice(b.at, end + 1).join('\n');
    b.injection.command = joined(linesOf(lines, b.at + 1, end)) || joined([lines[b.at]!]);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const shut = open.length ? closingFence(line) : null;
    if (shut) {
      const still: typeof open = [];
      for (const b of open) {
        if (b.fence.char === shut.char && b.fence.length <= shut.length) close(b, i);
        else still.push(b);
      }
      open = still;
      continue;
    }
    // Any line that opens a ```! block starts its own command, inside another open block too (contract §5.3).
    const fence = openingFence(line);
    if (fence) {
      if (open.length === MAX_OPEN) {
        const first = out.findIndex((x) => x === open[0]!.injection);
        out.length = first;
        out.push({ line: open[0]!.at + 1, text: lines.slice(open[0]!.at).join('\n'), command: joined(linesOf(lines, open[0]!.at + 1, lines.length)) });
        return out;
      }
      const injection: Injection = { line: i + 1, text: '', command: '' };
      out.push(injection);
      open.push({ fence, at: i, injection });
    } else if (!open.length && line.includes('!`')) out.push({ line: i + 1, text: line, command: joined(inlineCommands(line)) });
  }
  for (const b of open) close(b, lines.length);
  return out;
}

// A markdown file's injected commands. One that isn't text (not valid UTF-8, or a NUL in it) can't be read for them, so
// it counts as one, at line 1: the detector errs toward asking.
const NOT_TEXT = 'not valid UTF-8 text';
function injectionsIn(f: TreeFile): Injection[] {
  if (!isMarkdown(f.path)) return [];
  return isText(f.bytes) ? injections(decodeText(f.bytes)) : [{ line: 1, text: `${NOT_TEXT} ${Buffer.from(f.bytes).toString('base64')}`, command: NOT_TEXT }];
}

// The injected commands a new version of a markdown file adds or changes: those whose text isn't in the old version.
function newInjections(a: TreeFile | undefined, b: TreeFile): Injection[] {
  if (!isMarkdown(b.path)) return [];
  const old = new Map<string, number>();
  for (const x of a ? injectionsIn(a) : []) old.set(x.text, (old.get(x.text) ?? 0) + 1);
  return injectionsIn(b).filter((x) => {
    const n = old.get(x.text) ?? 0;
    if (n > 0) old.set(x.text, n - 1);
    return n === 0;
  });
}

// The lines that shape blocks: those whose first non-blanks are three or more backticks or tildes, with or without a
// `!` (an opening fence, a close, or a doubtful one), in order; and whether any opens a ```! block.
function fenceLines(text: string): { fences: { line: number; text: string }[]; opener: boolean } {
  const fences: { line: number; text: string }[] = [];
  let opener = false;
  text.split(LINE_BREAK).forEach((l, i) => {
    if (!l.includes('`') && !l.includes('~')) return;
    const at = skipBlanks(l, 0);
    const char = l[at];
    if ((char !== '`' && char !== '~') || countRun(l, at, char) < 3) return;
    fences.push({ line: i + 1, text: l });
    opener ||= openingFence(l) !== null;
  });
  return { fences, opener };
}
// An update that adds, removes or changes a fence line in a markdown file with a ```! block (before or after) can
// re-nest what the blocks hold, so more may run as the skill loads with no command's own text changed: it counts as
// runs_at_load, at the first fence line that differs (the detector errs toward asking). With the fence lines the same,
// every block spans the same lines, and an edit inside one changes that command's text.
function fenceChange(a: TreeFile, b: TreeFile): { line: number; text: string } | null {
  if (!isMarkdown(b.path) || !isText(a.bytes) || !isText(b.bytes)) return null;
  const was = fenceLines(decodeText(a.bytes));
  const now = fenceLines(decodeText(b.bytes));
  if (!was.opener && !now.opener) return null;
  const n = Math.max(was.fences.length, now.fences.length);
  for (let i = 0; i < n; i++) {
    if (was.fences[i]?.text === now.fences[i]?.text) continue;
    const at = now.fences[i] ?? now.fences[now.fences.length - 1];
    return { line: at?.line ?? 1, text: (now.fences[i] ?? was.fences[i])!.text.trim() };
  }
  return null;
}

// What a version grants, so a changed instruction could act without asking (contract §5.3): an injected command, or a
// front matter key on neither the safe list nor the non-granting list. Each says what it grants, for the flag's detail.
function grantsOf(files: readonly TreeFile[], fm: Record<string, unknown>, safeKeys: readonly string[], nonGranting: readonly string[]): string[] {
  const grants = Object.keys(fm)
    .filter((k) => !safeKeys.includes(k) && !nonGranting.includes(k))
    .sort()
    .map((k) => (k === 'allowed-tools' ? `pre-approves ${show(fm[k])}` : `sets ${k} in its front matter`));
  if (files.some((f) => injectionsIn(f).length > 0)) grants.unshift('runs a command as it loads');
  return grants;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(a, b) === 0;
}

// A side's front matter. Only "no version yet" has none: a SKILL.md that is missing, not text or not parseable is
// refused, never diffed as if it had no front matter, which would hide every key it grants (contract §5.3).
function frontmatterOf(files: readonly TreeFile[]): { fm: Record<string, unknown>; body: string | null; lines: string[] } {
  if (files.length === 0) return { fm: {}, body: null, lines: [] };
  const f = files.find((x) => x.path === MANIFEST);
  if (!f) throw new CatalogError('invalid_manifest', { problem: 'missing', fields: [MANIFEST] });
  if (!isText(f.bytes)) throw new CatalogError('invalid_manifest', { problem: 'not_utf8', fields: [MANIFEST] });
  const text = decodeText(f.bytes);
  const parsed = parseFrontmatter(text);
  return { fm: parsed.frontmatter, body: parsed.body, lines: text.split('\n') };
}

function show(v: unknown): string {
  if (Array.isArray(v)) return v.map(show).join(', ');
  if (v !== null && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function keyLine(lines: string[], key: string): number | undefined {
  const i = lines.findIndex((l) => l.startsWith(`${key}:`));
  return i >= 0 ? i + 1 : undefined;
}

// `configuredSafeKeys` can only narrow the fixed safe list (contract §5.3): a key not on it always counts.
// `configuredNonGrantingKeys` can only narrow the fixed non-granting list the same way.
export function diffTrees(
  from: DiffSide | null,
  to: DiffSide,
  configuredSafeKeys: readonly string[] = DEFAULT_SAFE_FRONTMATTER_KEYS,
  configuredNonGrantingKeys: readonly string[] = DEFAULT_NON_GRANTING_KEYS,
): TreeDiff {
  const safeKeys = configuredSafeKeys.filter((k) => DEFAULT_SAFE_FRONTMATTER_KEYS.includes(k));
  const nonGranting = configuredNonGrantingKeys.filter((k) => DEFAULT_NON_GRANTING_KEYS.includes(k));
  const before = new Map((from?.files ?? []).map((f) => [f.path, f]));
  const after = new Map(to.files.map((f) => [f.path, f]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const files: FileChange[] = [];
  const risk: RiskFlag[] = [];
  const changed: { a?: TreeFile; b?: TreeFile; path: string }[] = [];
  for (const path of paths) {
    const a = before.get(path);
    const b = after.get(path);
    let status: FileChange['status'];
    if (!a) status = 'added';
    else if (!b) status = 'removed';
    else if (!sameBytes(a.bytes, b.bytes) || a.mode !== b.mode) status = 'changed';
    else continue;
    const shown = (b ?? a)!;
    const flags = fileFlags(shown);
    const change: FileChange = { path, status, flags };
    const binary = (a && !isText(a.bytes)) || (b && !isText(b.bytes));
    if (!binary) {
      change.unified = unifiedDiff(a ? decodeText(a.bytes) : null, b ? decodeText(b.bytes) : null, path, modeNote(a?.mode, b?.mode));
    }
    files.push(change);
    changed.push({ a, b, path });
  }

  const fa = frontmatterOf(from?.files ?? []);
  const fb = frontmatterOf(to.files);
  // One reason per file, the first that applies (contract §5.3): runnable_file, runs_at_load (one per added or changed
  // injected command, and nothing else for that file), instructions_changed (any file added, changed or removed, and
  // SKILL.md when its body or a safe key changed, while the new version grants anything), then non_markdown.
  const grants = grantsOf(to.files, fb.fm, safeKeys, nonGranting);
  const safeChanged = safeKeys.some((k) => JSON.stringify(fa.fm[k]) !== JSON.stringify(fb.fm[k]));
  for (const { a, b, path } of changed) {
    const own = b ? fileRisk(b) : null;
    if (own?.kind === 'runnable_file') {
      risk.push(own);
      continue;
    }
    const injected = b ? newInjections(a, b) : [];
    if (injected.length) {
      for (const x of injected) risk.push({ kind: 'runs_at_load', path, line: x.line, detail: flagText(x.command) });
      continue;
    }
    const fence = a && b ? fenceChange(a, b) : null;
    if (fence) {
      risk.push({ kind: 'runs_at_load', path, line: fence.line, detail: flagText(fence.text) });
      continue;
    }
    const instructions = path !== MANIFEST || fa.body !== fb.body || safeChanged;
    if (grants.length && instructions) {
      risk.push({ kind: 'instructions_changed', path, detail: flagText(grants.join(' and ')) });
      continue;
    }
    if (own) risk.push(own);
  }
  const keys = [...new Set([...Object.keys(fa.fm), ...Object.keys(fb.fm)])].sort();
  const frontmatter_changes = keys
    .filter((k) => JSON.stringify(fa.fm[k]) !== JSON.stringify(fb.fm[k]))
    .map((k) => ({ field: k, from: fa.fm[k] ?? null, to: fb.fm[k] ?? null }));
  for (const k of keys.filter((key) => !safeKeys.includes(key))) {
    const was = fa.fm[k];
    const now = fb.fm[k];
    if (JSON.stringify(was) === JSON.stringify(now)) continue;
    const detail =
      was === undefined ? `${k} added: ${show(now)}` : now === undefined ? `${k} removed` : `${k} changed: ${show(was)} → ${show(now)}`;
    const line = now === undefined ? undefined : keyLine(fb.lines, k);
    risk.push({ kind: 'capability_frontmatter', path: MANIFEST, ...(line ? { line } : {}), field: k, from: flagValue(was ?? null), to: flagValue(now ?? null), detail: flagText(detail) });
  }
  const publisher_changed = from !== null && from.publisher !== to.publisher;
  if (publisher_changed) risk.push({ kind: 'new_publisher', from: flagText(from!.publisher), to: flagText(to.publisher), detail: flagText(`${from!.publisher} → ${to.publisher}`) });
  // A path is publisher text too (checked at publish, but a flag is shown wherever it goes).
  return { files, frontmatter_changes, publisher_changed, risk_flags: risk.map((f) => (f.path === undefined ? f : { ...f, path: flagText(f.path) })) };
}

function modeNote(a?: Mode, b?: Mode): string {
  return a && b && a !== b ? `old mode ${a}\nnew mode ${b}\n` : '';
}

// ---------- unified diff (Myers, 3 lines of context, git's headers) ----------

// Lines keep their ending, so "x" and "x\n" differ, as they do on disk.
function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

type Op = { kind: ' ' | '-' | '+'; line: string; ai: number; bi: number };

const MAX_EDIT = 4000;

// Shortest edit script (Myers 1986). Past MAX_EDIT differences it gives up on alignment and replaces the whole file.
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDIT);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  if (found < 0) {
    return [...a.map((line, i) => ({ kind: '-' as const, line, ai: i, bi: 0 })), ...b.map((line, i) => ({ kind: '+' as const, line, ai: n, bi: i }))];
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1]! < vd[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: ' ', line: a[x - 1]!, ai: x - 1, bi: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) ops.push({ kind: '+', line: b[y - 1]!, ai: x, bi: y - 1 });
    else ops.push({ kind: '-', line: a[x - 1]!, ai: x - 1, bi: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: ' ', line: a[x - 1]!, ai: x - 1, bi: y - 1 });
    x--;
    y--;
  }
  return ops.reverse();
}

function range(start: number, count: number): string {
  if (count === 0) return `${start},0`;
  return count === 1 ? `${start}` : `${start},${count}`;
}

function emit(op: Op): string {
  const body = op.line.endsWith('\n') ? op.line : op.line + '\n\\ No newline at end of file\n';
  return op.kind + body;
}

export function unifiedDiff(before: string | null, after: string | null, path: string, header = '', context = 3): string {
  const a = before === null ? [] : splitLines(before);
  const b = after === null ? [] : splitLines(after);
  const ops = editScript(a, b);
  const changed = ops.map((o, i) => (o.kind !== ' ' ? i : -1)).filter((i) => i >= 0);
  let out = header + `--- ${before === null ? '/dev/null' : 'a/' + path}\n+++ ${after === null ? '/dev/null' : 'b/' + path}\n`;
  if (changed.length === 0) return header ? header : '';
  let i = 0;
  while (i < changed.length) {
    const lo = Math.max(0, changed[i]! - context);
    let hi = Math.min(ops.length - 1, changed[i]! + context);
    while (i + 1 < changed.length && changed[i + 1]! - context <= hi + 1) {
      i++;
      hi = Math.min(ops.length - 1, changed[i]! + context);
    }
    i++;
    const hunk = ops.slice(lo, hi + 1);
    const aCount = hunk.filter((o) => o.kind !== '+').length;
    const bCount = hunk.filter((o) => o.kind !== '-').length;
    const first = hunk[0]!;
    const aStart = aCount === 0 ? first.ai : first.ai + 1;
    const bStart = bCount === 0 ? first.bi : first.bi + 1;
    out += `@@ -${range(aStart, aCount)} +${range(bStart, bCount)} @@\n` + hunk.map(emit).join('');
  }
  return out;
}
