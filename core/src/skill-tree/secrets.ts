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

const RULES: readonly [SecretKind, RegExp][] = [
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/],
  ['password_or_token', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\s*[:=]\s*['"]?[A-Za-z0-9/+_\-.]{12,}/i],
];

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
