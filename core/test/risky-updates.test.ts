// Risky updates wait for a yes (contract §5.3): the flags a version's diff raises, driven by the golden's pairs as they are
// (golden/histories.yaml, histories.gate). Each pair is (installed version, new version), `from: null` a first install,
// and its risk_flags are compared as a set, on the fields the golden gives.

import { describe, expect, it } from 'vitest';
import { checkTree, diffTrees, type RiskFlag } from '../src/skill-tree/index.ts';
import { filesOf, loadGolden } from './golden.ts';

const histories = loadGolden('histories.yaml');
const pairs: { from: string | null; to: string; risk_flags: Partial<RiskFlag>[]; note?: string }[] = histories.histories.gate.pairs;
const side = (ref: string) => ({ files: checkTree(filesOf(histories.versions[ref])!), publisher: 'dev1' });
const key = (f: Partial<RiskFlag>) => `${f.kind}|${f.path ?? ''}|${f.line ?? ''}|${f.field ?? ''}`;
const sorted = <T extends Partial<RiskFlag>>(fs: readonly T[]) => [...fs].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

// A file SKILL.md puts in a command position, and a command naming a file outside the skill (runnable_file's other
// rules in §5.3) aren't built yet: these pairs fail until they are, and flag the day they pass.
const COMMAND_POSITIONS = new Set(['gate.g0-cmdpos', 'gate.g0-bang-target', 'gate.g0-cmdwords', 'gate.g0-outside-dir', 'gate.g0-outside-rel', 'gate.g0-outside-skills']);

describe('the flags an update raises, pair by pair (golden histories.gate)', () => {
  for (const p of pairs) {
    const name = `${p.from ?? 'nothing'} -> ${p.to}: ${p.risk_flags.map((f) => f.kind).join(', ') || 'no flags'}`;
    const run = () => {
      const d = diffTrees(p.from === null ? null : side(p.from), side(p.to));
      expect(sorted(d.risk_flags), p.note).toMatchObject(sorted(p.risk_flags));
    };
    if (COMMAND_POSITIONS.has(p.to)) {
      it.fails(name, run);
      // The half that's built holds today: every flag but those on a command position's file, which today has its
      // other reason (non_markdown) or none.
      it(`${name}, without the command positions`, () => {
        const d = diffTrees(p.from === null ? null : side(p.from), side(p.to));
        const positions = new Set(p.risk_flags.filter((f) => f.kind === 'runnable_file').map((f) => f.path));
        expect(sorted(d.risk_flags.filter((f) => !positions.has(f.path)))).toMatchObject(sorted(p.risk_flags.filter((f) => !positions.has(f.path))));
      });
    } else it(name, run);
  }
});

// The injected-command detector (contract §5.3, 96274fb): lines end at LF, CR, U+2028 or U+2029; the blanks before a
// fence are spaces, tabs and the invisible set; a markdown file that isn't valid UTF-8 is flagged at line 1.
describe('an injected command is found however the file is written', () => {
  const md = (body: string | Uint8Array) => ({ path: 'SKILL.md', mode: '0644', bytes: typeof body === 'string' ? Buffer.from(`---\nname: x\ndescription: y\n---\n${body}`) : body });
  const plain = checkTree([md('Plain.\n')]);
  const flagsFor = (body: string | Uint8Array) => diffTrees({ files: plain, publisher: 'a' }, { files: checkTree([md(body)]), publisher: 'a' }).risk_flags;
  const at = (body: string, line: number) => expect(flagsFor(body).map((f) => [f.kind, f.line])).toEqual([['runs_at_load', line]]);

  it('a ```! block with CRLF line endings, and a five-backtick fence', () => {
    at('Plain.\r\n```!\r\necho QA-MARKER\r\n```\r\n', 6);
    at('Plain.\n`````!\necho QA-MARKER\n`````\n', 6);
  });
  it('a fence after a CR, U+2028 or U+2029 line break', () => {
    for (const br of ['\r', ' ', ' ']) at(`Plain.${br}\`\`\`!\necho QA-MARKER\n\`\`\`\n`, 6);
  });
  it('a fence after a no-break space, a zero-width space or a byte-order mark', () => {
    for (const blank of [' ', '​', '﻿']) at(`Plain.\n${blank}\`\`\`!\necho QA-MARKER\n\`\`\`\n`, 6);
  });
  it('a markdown file that isn\'t valid UTF-8, or holds a NUL, is flagged at line 1', () => {
    for (const bytes of [Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]), Buffer.from('Plain.\n\u0000!`echo QA-MARKER`\n')]) {
      const d = diffTrees({ files: plain, publisher: 'a' }, { files: checkTree([md('Plain.\n'), { path: 'notes.md', mode: '0644', bytes }]), publisher: 'a' });
      expect(d.risk_flags.map((f) => [f.kind, f.path, f.line])).toEqual([['runs_at_load', 'notes.md', 1]]);
    }
  });
  it('names the command in the flag\'s detail', () => {
    expect(flagsFor('Plain.\n- PR diff: !`gh pr diff`\n')[0]!.detail).toBe('gh pr diff');
    expect(flagsFor('Plain.\n```!\necho QA-MARKER\n```\n')[0]!.detail).toBe('echo QA-MARKER');
  });
  it('scans a megabyte-long markdown file in well under a second', () => {
    // Each within the core's 1 MiB file limit.
    for (const body of ['`'.repeat(1_000_000), '!`'.repeat(500_000), '```!\n'.repeat(200_000), ' '.repeat(300_000), ' '.repeat(400_000) + '```!']) {
      const start = performance.now();
      flagsFor(body);
      expect(performance.now() - start).toBeLessThan(1000);
    }
  });
});
