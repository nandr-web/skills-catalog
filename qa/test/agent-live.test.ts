// Live checks with a real assistant (brief §2.2 and §2.7). They spend money on the owner's Claude login, so they run only
// with QA_LIVE=1: `QA_LIVE=1 npx vitest run test/agent-live.test.ts`. Each run is capped with --max-budget-usd.
//   1. The stand-in person works: Claude Code sends a permission prompt to it, and it refuses or approves as agreed.
//   2. The smoke test (needs QA_MOCK, the command that serves the agent-experience trials' mock): A1-A3, MCP only, Haiku, 1 try.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { claudeCommand, mcpConfig } from '../src/agent/command.ts';
import { loadSurface } from '../src/agent/surface.ts';
import { parseTrace } from '../src/agent/trace.ts';
import { runScenarios } from '../src/agent/runner.ts';
import { createSandbox, recordSession } from '../src/sandbox.ts';
import { teardown } from '../src/teardown.ts';
import { newRunId } from '../src/run.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const LIVE = !!process.env.QA_LIVE;

describe.skipIf(!LIVE)('live: the stand-in person answers Claude Code\'s permission prompts', () => {
  const surface = loadSurface(`${here('./fixtures/surface.yaml')}#proposed`);
  const noCatalog = { name: 'none', mcp: false, allowed: [], companionSkill: false, cliOnPath: false };
  // A request that always prompts in the default mode: writing a file (a harmless `echo` is auto-allowed, so it never asks).
  const ask = 'Use the Write tool to create a file named qa-person-check.txt in the current folder, containing the word ok. Then say done, or say what stopped you.';

  async function attempt(agreesTo: string[]) {
    const sb = createSandbox({ runId: `${newRunId()}-person` });
    try {
      const log = join(sb.root, 'person.jsonl'), cfg = join(sb.root, 'mcp.json');
      writeFileSync(cfg, JSON.stringify(mcpConfig({ setup: noCatalog, surface, catalog: [], env: sb.env, person: { agreesTo, log } })));
      const cmd = claudeCommand({ ask, model: 'claude-haiku-4-5-20251001', setup: noCatalog, surface, mcpConfig: cfg, budgetUsd: 0.1 });
      const r = spawnSync(cmd[0], cmd.slice(1), { cwd: sb.dirs.work, env: { ...process.env, ...sb.env }, encoding: 'utf8', timeout: 180_000 });
      const trace = parseTrace(r.stdout);
      for (const s of trace.sessions) recordSession(sb, s);
      const person = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
      return { trace, person, wrote: existsSync(join(sb.dirs.work, 'qa-person-check.txt')) };
    } finally {
      await teardown(sb);
    }
  }

  it('refuses a tool the scenario doesn\'t agree to, and the trace shows the refusal', async () => {
    const { trace, person, wrote } = await attempt([]);
    expect(person.map((p: any) => [p.tool_name, p.decision])).toContainEqual(['Write', 'deny']);
    expect(trace.result?.permissionDenials.length).toBeGreaterThan(0);
    expect(wrote).toBe(false);
  }, 200_000);

  it('approves a tool the scenario agrees to', async () => {
    const { person, wrote } = await attempt(['Write']);
    expect(person.map((p: any) => [p.tool_name, p.decision])).toContainEqual(['Write', 'allow']);
    expect(wrote).toBe(true);
  }, 200_000);
});

describe.skipIf(!LIVE || !process.env.QA_MOCK)('live: smoke test on the agent-experience trials\' mock (A1-A3, MCP only, Haiku, 1 try)', () => {
  it('runs, scores and leaves nothing behind', async () => {
    const out = join(process.env.QA_OUT ?? here('../out'), `smoke-${newRunId()}`);
    const report = await runScenarios({
      scenariosFile: here('../golden/agent-scenarios.yaml'), queriesFile: here('../golden/queries.yaml'), phrasesFile: here('../golden/phrases.yaml'),
      surface: process.env.QA_SURFACE!, catalogCommand: JSON.parse(process.env.QA_MOCK!), scenarios: ['A1', 'A2', 'A3'], setups: ['mcp'],
      models: ['claude-haiku-4-5-20251001'], tries: 1, out,
    });
    console.log(readFileSync(join(out, 'summary.txt'), 'utf8'));
    expect(report.stopped).toBeUndefined();
    expect(report.runs).toHaveLength(3);
    expect(report.runs.every((r) => r.differences.length === 0)).toBe(true);
    expect(report.runs.reduce((a, r) => a + r.metrics.cost_usd, 0)).toBeLessThan(0.5);
  }, 900_000);
});
