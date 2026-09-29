// The secret scan against the golden's rows as they are (golden/skills.yaml secret_scan, contract §2): each line is the
// only line of notes.md beside a valid SKILL.md; each file is scanned with its exact bytes. Values the golden keeps as
// {join: [...]} are joined here, at test time only, so no whole key sits in the goldens or the product.

import { describe, expect, it } from 'vitest';
import { scanSecrets, type TreeFile } from '../src/skill-tree/index.ts';
import { loadGolden } from './golden.ts';

const golden = loadGolden('skills.yaml').secret_scan;
type Line = string | { join: string[] };
const text = (l: Line) => (typeof l === 'string' ? l : l.join.join(''));
const skillMd: TreeFile = { path: 'SKILL.md', mode: '0644', bytes: Buffer.from('---\nname: notes\ndescription: Holds notes.\n---\nSee notes.md.\n') };
const scanLine = (line: string) => scanSecrets([skillMd, { path: 'notes.md', mode: '0644', bytes: Buffer.from(`${line}\n`) }]);

// The kinds the scan gets with the new shapes (stripe_key, google_api_key, jwt, url_credentials), and the files it
// decodes from UTF-16 and Latin-1, aren't built yet: these rows fail until they are, and flag the day they pass. What
// the scan gives for each of them today is pinned too, so a regression can't hide behind an expected failure.
const NOT_YET = new Set(['stripe_key', 'google_api_key', 'jwt', 'url_credentials']);
const TODAY: Record<string, string> = { 'order-stripe-first': 'password_or_token' };

describe('each golden line gives its kind, or nothing (golden secret_scan.lines)', () => {
  for (const row of golden.lines as { id: string; line: Line; expect: string }[]) {
    const run = () => expect(scanLine(text(row.line))).toEqual(row.expect === 'none' ? null : { path: 'notes.md', line: 1, kind: row.expect });
    if (NOT_YET.has(row.expect)) {
      it.fails(row.id, run);
      it(`${row.id}, today`, () => expect(scanLine(text(row.line))?.kind ?? null).toBe(TODAY[row.id] ?? null));
    } else it(row.id, run);
  }
});

describe('a value kept joined is exactly what the scan flags, so a broken join can\'t pass', () => {
  for (const row of (golden.lines as { id: string; line: Line; expect: string }[]).filter((r) => typeof r.line !== 'string')) {
    const run = () => {
      const parts = (row.line as { join: string[] }).join;
      expect(scanLine(parts.join(''))?.kind).toBe(row.expect === 'none' ? undefined : row.expect);
      // Without the join, no part alone is a secret.
      for (const part of parts) expect(scanLine(part)).toBeNull();
    };
    if (NOT_YET.has(row.expect)) it.fails(row.id, run);
    else it(row.id, run);
  }
});

describe('files in other encodings are scanned as decoded text (golden secret_scan.files)', () => {
  for (const row of golden.files as { id: string; path: string; content: { base64: string }; expect: 'none' | { line: number; kind: string } }[]) {
    const run = () => {
      const f: TreeFile = { path: row.path, mode: '0644', bytes: Buffer.from(row.content.base64, 'base64') };
      expect(scanSecrets([skillMd, f])).toEqual(row.expect === 'none' ? null : { path: row.path, ...row.expect });
    };
    if (row.expect !== 'none') {
      it.fails(row.id, run);
      it(`${row.id}, today: not decoded yet`, () => expect(scanSecrets([skillMd, { path: row.path, mode: '0644', bytes: Buffer.from(row.content.base64, 'base64') }])).toBeNull());
    } else it(row.id, run);
  }
});
