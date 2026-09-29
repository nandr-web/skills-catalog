// The platform check that runs before anything else (contract §8): Node 24.15 or later, with FTS5 in node:sqlite.
// It is plain JavaScript, so an older Node can run it and say so in one line, instead of failing on TypeScript.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, on purpose (it must run on any Node)
import { NEED, nodeProblem, problemLine } from '../scripts/node-check.mjs';
import { Words } from '../src/words-file.ts';
import { processEnv } from './process-env.ts';
import { sandbox } from './sandbox.ts';

describe('the Node check (contract §8)', () => {
  it('needs 24.15 or later, and FTS5 in node:sqlite', () => {
    expect(NEED).toBe('24.15.0');
    for (const have of ['22.12.0', '24.14.9', '23.9.0', '18.20.4']) expect(nodeProblem(have, true), have).toEqual({ problem: 'too_old', need: '24.15.0', have });
    for (const have of ['24.15.0', '24.16.1', '25.2.1', '26.0.0']) expect(nodeProblem(have, true), have).toBeNull();
    expect(nodeProblem('25.2.1', false)).toEqual({ problem: 'no_fts5', need: '24.15.0', have: '25.2.1' });
  });

  it('says what is wrong in the words file\'s words', async () => {
    const s = Words.load();
    for (const p of [{ problem: 'too_old', need: '24.15.0', have: '22.12.0' }, { problem: 'no_fts5', need: '24.15.0', have: '25.2.1' }]) {
      expect(await problemLine(p)).toBe(s.format(s.word(`node_${p.problem}`), { need: p.need, have: p.have }));
    }
  });

  it('passes quietly on this Node: exit 0, nothing printed', () => {
    const r = spawnSync(process.execPath, [join(import.meta.dirname, '..', 'scripts', 'node-check.mjs')], { env: processEnv(sandbox()), encoding: 'utf8' });
    expect([r.status, r.stdout, r.stderr]).toEqual([0, '', '']);
  });
});
