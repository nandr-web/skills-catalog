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
    if (COMMAND_POSITIONS.has(p.to)) it.fails(name, run);
    else it(name, run);
  }
});
