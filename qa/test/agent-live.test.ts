// Live checks with a real assistant (brief §2.2 and §2.7). They spend money on the owner's Claude login, so they run only
// with QA_LIVE=1: `QA_LIVE=1 npx vitest run test/agent-live.test.ts`. Each run is capped with --max-budget-usd. They act
// on the real machine, so each runs as the live runner in a child process, never inside the test process.
//   1. The stand-in person works: Claude Code sends a permission prompt to it, and it refuses or approves as agreed.
//   2. The smoke test (needs QA_MOCK, the command that serves a stand-in catalog, and QA_SURFACE): A1-A3, MCP only, Haiku, 1 try.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newRunId } from '../src/sandbox.ts';
import { nodeOnRealMachineSync, qaOnRealMachineSync } from './machine.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const LIVE = process.env.QA_LIVE === '1';

describe.skipIf(!LIVE)('live: the stand-in person answers Claude Code\'s permission prompts', () => {
  const attempt = (agreesTo: string[]) => {
    const r = nodeOnRealMachineSync(here('./live/person-check.ts'), [JSON.stringify(agreesTo)]);
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').pop()!);
  };

  it('refuses a tool the scenario doesn\'t agree to, and the trace shows the refusal', () => {
    const { person, denials, wrote } = attempt([]);
    expect(person.map((p: any) => [p.tool_name, p.decision])).toContainEqual(['Write', 'deny']);
    expect(denials).toBeGreaterThan(0);
    expect(wrote).toBe(false);
  }, 200_000);

  it('approves a tool the scenario agrees to', () => {
    const { person, wrote } = attempt(['Write']);
    expect(person.map((p: any) => [p.tool_name, p.decision])).toContainEqual(['Write', 'allow']);
    expect(wrote).toBe(true);
  }, 200_000);
});

describe.skipIf(!LIVE || !process.env.QA_MOCK)('live: smoke test on a stand-in catalog (A1-A3, MCP only, Haiku, 1 try)', () => {
  it('runs, scores and leaves nothing behind', () => {
    const out = join(process.env.QA_OUT ?? here('../out'), `smoke-${newRunId()}`);
    const r = qaOnRealMachineSync(['agent', '--surface', process.env.QA_SURFACE!, '--mcp', process.env.QA_MOCK!, '--scenario', 'A1,A2,A3', '--setup', 'mcp',
      '--models', 'haiku', '--tries', '1', '--out', out, '--no-preflight']);
    console.log(r.stdout);
    const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
    expect(report.stopped).toBeUndefined();
    expect(report.runs).toHaveLength(3);
    expect(report.runs.every((x: any) => x.differences.length === 0)).toBe(true);
    expect(report.runs.reduce((a: number, x: any) => a + x.metrics.cost_usd, 0)).toBeLessThan(0.5);
  }, 900_000);
});
