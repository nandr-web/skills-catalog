// How many tries the agent scenario runner gives each model (brief §2), with the fake `claude` of agent-runner.test.ts.
// Eight tries, each with its sandbox, teardown and before/after check (processes and ports included), take most of a
// second each on a busy machine, so this runs with `npm run test:slow` (listed in test/slow.json), not with `npm test`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScenarios } from '../src/agent/runner.ts';
import { base, forgetFakeClaude, machine, traceFile } from './agent-setup.ts';
import { cleanup, PROCESS_TEST_MS } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

afterEach(() => { cleanup(); forgetFakeClaude(); });

describe('agent scenario runner (fake claude)', () => {
  it('five tries for Haiku on the discovery asks, three otherwise, unless --tries says', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const report = await runScenarios({ ...base(m), tries: undefined, scenarios: ['A1'], setups: ['mcp'], models: ['claude-haiku-4-5-20251001', 'claude-opus-5-5'] });
    expect(report.summary.map((s) => [s.model, s.tries])).toEqual([['claude-haiku-4-5-20251001', 5], ['claude-opus-5-5', 3]]);
  }, 30_000);   // several tries, each with its before/after check (processes and ports included)
});
