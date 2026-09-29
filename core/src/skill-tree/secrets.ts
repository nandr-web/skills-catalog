// The secret scan (contract §2, §5.1 step 1): the same function the client's publish preview and the core's publish run,
// so no face can skip it. The rule is a secret's shape, with no allow-list: AWS's documented example key is flagged too.
// A hit names the file, the line and the kind, never the value.

import { decodeText, isText, type TreeFile } from './tree.ts';

export type SecretKind = 'aws_access_key' | 'private_key' | 'github_token' | 'slack_token' | 'anthropic_key' | 'openai_key' | 'password_or_token';

export interface SecretHit {
  path: string;
  line: number;
  kind: SecretKind;
}

// A token's edges are letters and digits only (`(?<![A-Za-z0-9])`, not `\b`): an underscore before a shape, as in a
// variable's name, must not hide it.
const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';

// ---------- password_or_token: a setting whose key names a secret, set to a value that holds one ----------

// The words a key names a secret with, as a whole part of it (contract §2): each joined by _, -, a space or nothing, and
// a part may end in the word (MYPASSWORD, apiKey). A part right after the word that names something else about it
// (password_hint, DB_PASSWORD_FILE, SECRET_KEY_FILE) means the key isn't the secret itself; the longest word decides.
const WORDS: readonly (readonly string[])[] = [
  ['secret', 'key'], ['private', 'key'], ['api', 'key'], ['access', 'key'], ['access', 'token'], ['auth', 'token'],
  ['password'], ['passwd'], ['secret'], ['token'],
];
const ABOUT = new Set(['hint', 'length', 'len', 'min', 'max', 'policy', 'prompt', 'label', 'field', 'name', 'file', 'path', 'type', 'count', 'expiry', 'expires', 'ttl', 'url']);

export function namesSecret(key: string): boolean {
  const parts = key.toLowerCase().split(/[_.\- ]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    let end = -1;
    for (const w of WORDS) {
      const e = parts[i]!.endsWith(w.join('')) ? i : w.length === 2 && parts[i]!.endsWith(w[0]!) && parts[i + 1] === w[1] ? i + 1 : -1;
      end = Math.max(end, e);
    }
    if (end >= 0 && !ABOUT.has(parts[end + 1] ?? '')) return true;
  }
  return false;
}

// A value that refers to a secret instead of holding one (contract §2): a placeholder, a read of the environment, a call,
// or a dotted name. Each is the whole value (a trailing ; , or ) allowed), never only its start, so a secret that merely
// begins like one (Summer.Time2024!, $uperSecret, <x>secret) is still flagged. An environment variable's name is upper
// case. A call is a name followed by `(`.
const TAIL = '[;,)]*$';
const REFERENCE = [
  new RegExp(`^<[^<>\\s]*>${TAIL}`),
  new RegExp(`^\\$\\{[^}]*\\}${TAIL}`),
  new RegExp(`^\\$env:[A-Za-z_][A-Za-z0-9_]*${TAIL}`),
  new RegExp(`^\\$[A-Z_][A-Z0-9_]*${TAIL}`),
  new RegExp(`^(?:process\\.env(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[(["'])[^"']*\\1\\])|os\\.environ(?:\\[(["'])[^"']*\\2\\]|\\.get\\([^)]*\\))|os\\.getenv\\([^)]*\\)|ENV\\[(["'])[^"']*\\3\\]|System\\.getenv\\([^)]*\\))${TAIL}`),
  /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\(/,
  new RegExp(`^[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)+${TAIL}`),
];
// A JWT (three base64url parts, the first starting eyJ) and a Google OAuth token (ya29.) are a secret's value, though
// they read like a dotted name.
const NEVER_A_REFERENCE = /^(?:eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.|ya29\.)/;
export const refersToSecret = (raw: string) => {
  const value = raw.replace(/^(["'])(.*)\1([;,)]*)$/, '$2$3');   // the reference as written, inside its quotes
  return !NEVER_A_REFERENCE.test(value) && REFERENCE.some((re) => re.test(value));
};

// Every walk is bounded, so a line of any length is scanned in linear time: no pattern here can backtrack.
const MAX_KEY = 200;
const MAX_GAP = 64;
const MAX_VALUE = 256;
const MIN_VALUE = 12;
const isKeyChar = (c: string) => /[A-Za-z0-9_.\- ]/.test(c);
const isQuote = (c: string | undefined) => c === '"' || c === "'";
const isSpace = (c: string | undefined) => c !== undefined && /\s/.test(c);

// The value after a separator: optional spaces, an optional opening quote, then characters that aren't spaces or quotes;
// and the raw word as written (quotes, brackets and all), to tell a reference from a secret.
function valueAt(line: string, from: number): { value: string; raw: string } {
  let i = from;
  for (let n = 0; n < MAX_GAP && isSpace(line[i]); n++) i++;
  let k = i;
  while (k < line.length && k - i < MAX_VALUE && !isSpace(line[k])) k++;
  const raw = line.slice(i, k);
  if (isQuote(line[i])) i++;
  let j = i;
  while (j < line.length && j - i < MAX_VALUE && !isSpace(line[j]) && !isQuote(line[j])) j++;
  return { value: line.slice(i, j), raw };
}

// The key is checked first, so a line of many separators only reads the values of keys that name a secret.
const holdsSecret = (key: string, line: string, from: number) => {
  if (!namesSecret(key)) return false;
  const { value, raw } = valueAt(line, from);
  return value.length >= MIN_VALUE && !refersToSecret(raw);
};

// A key, then an optional closing quote, `:`, `=`, `:=` or `=>` with spaces around it (MYPASSWORD=, "api key": "…",
// token := …, :password => …); or a --flag, then a space or `=` (--password …).
const SEPARATOR = /:=|=>|[:=]/g;
const FLAG = /(?<![A-Za-z0-9_.-])--([A-Za-z0-9][A-Za-z0-9_-]{0,199}) +/g;
function setting(line: string): boolean {
  for (const m of line.matchAll(SEPARATOR)) {
    let j = m.index - 1;
    for (let n = 0; n < MAX_GAP && isSpace(line[j]); n++) j--;
    if (isQuote(line[j])) j--;
    let i = j;
    while (i >= 0 && j - i < MAX_KEY && isKeyChar(line[i]!)) i--;
    const key = line.slice(i + 1, j + 1).trim();
    if (key && holdsSecret(key, line, m.index + m[0].length)) return true;
  }
  for (const m of line.matchAll(FLAG)) if (holdsSecret(m[1]!, line, m.index + m[0].length)) return true;
  return false;
}

const shape = (re: RegExp) => (line: string) => re.test(line);
const RULES: readonly [SecretKind, (line: string) => boolean][] = [
  ['aws_access_key', shape(new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}${END}`))],
  ['private_key', shape(/-----BEGIN [A-Z ]*PRIVATE KEY-----/)],
  ['github_token', shape(new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})${END}`))],
  ['slack_token', shape(new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}${END}`))],
  ['anthropic_key', shape(new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,}${END}`))],
  ['openai_key', shape(new RegExp(`${START}sk-(?:proj-)?[A-Za-z0-9]{32,}${END}`))],
  ['password_or_token', setting],
];

// Every kind a hit can have (the faces word each one).
export const SECRET_KINDS: readonly SecretKind[] = RULES.map(([kind]) => kind);

// The first suspected secret in a skill's text files, in path order, or null. Binary files aren't scanned.
export function scanSecrets(files: readonly TreeFile[]): SecretHit | null {
  for (const f of files) {
    if (!isText(f.bytes)) continue;
    const lines = decodeText(f.bytes).split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [kind, matches] of RULES) if (matches(lines[i]!)) return { path: f.path, line: i + 1, kind };
    }
  }
  return null;
}
