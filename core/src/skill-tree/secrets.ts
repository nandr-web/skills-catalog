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
// A setting (contract §2): a key, a run of letters, digits, _ - and ., that ends in one of these words (MYPASSWORD,
// DB_PASSWORD, client_secret, AWS_SECRET_ACCESS_KEY, "password", apiKey), then an optional closing quote, : or = with
// spaces around it, an optional opening quote and a value of 12 or more letters, digits and / + _ - . A key that goes
// on past the word (passwords, tokenizer, password_hint, TOKENS) isn't one.
const KEYWORD = '(?:password|passwd|secret|secret[_-]?key|private[_-]?key|api[_-]?key|access[_-]?key|access[_-]?token|auth[_-]?token|token)';
const SETTING = `(?<![A-Za-z0-9_.-])[A-Za-z0-9_.-]*${KEYWORD}['"]?\\s*[:=]\\s*['"]?[A-Za-z0-9/+_\\-.]{12,}`;

const RULES: readonly [SecretKind, RegExp][] = [
  ['aws_access_key', new RegExp(`${START}(?:AKIA|ASIA)[0-9A-Z]{16}${END}`)],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github_token', new RegExp(`${START}(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})${END}`)],
  ['slack_token', new RegExp(`${START}xox[abprs]-[A-Za-z0-9-]{10,}${END}`)],
  ['anthropic_key', new RegExp(`${START}sk-ant-[A-Za-z0-9_-]{20,}${END}`)],
  ['openai_key', new RegExp(`${START}sk-(?:proj-)?[A-Za-z0-9]{32,}${END}`)],
  ['password_or_token', new RegExp(SETTING, 'i')],
];

// Every kind a hit can have (the faces word each one).
export const SECRET_KINDS: readonly SecretKind[] = RULES.map(([kind]) => kind);

// The first suspected secret in a skill's text files, in path order, or null. Binary files aren't scanned.
export function scanSecrets(files: readonly TreeFile[]): SecretHit | null {
  for (const f of files) {
    if (!isText(f.bytes)) continue;
    const lines = decodeText(f.bytes).split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const [kind, re] of RULES) if (re.test(lines[i]!)) return { path: f.path, line: i + 1, kind };
    }
  }
  return null;
}
