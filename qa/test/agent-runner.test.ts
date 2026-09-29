// The agent scenario runner end to end (brief §2), with a fake `claude` that replays a recorded trace, so it costs nothing:
// a sandbox per try, the MCP config and companion skill per setup, the trace kept, sessions recorded, teardown and the
// before/after check, scores and the report. Live runs (a real assistant) are in agent-live.test.ts, behind QA_LIVE=1.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import { runScenarios } from '../src/agent/runner.ts';
import { RUN_ID } from '../src/safe-delete.ts';
import { cleanup, PROCESS_TEST_MS, machine as fakeMachine } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
afterEach(() => { cleanup(); for (const k of Object.keys(process.env)) if (k.startsWith('QA_FAKE_CLAUDE_')) delete process.env[k]; });

const machine = () => { const m = fakeMachine(); return { ...m, out: join(m.dir, 'out') }; };

/** The QA plan's direct-MCP spike trace, with the spike's stand-in tool renamed to this surface's search tool. */
function traceFile(dir: string, fixture: string) {
  const t = readFileSync(here(`../fixtures/traces/${fixture}`), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills');
  const p = join(dir, fixture);
  writeFileSync(p, t);
  return p;
}

const base = (m: ReturnType<typeof machine>) => ({
  scenariosFile: here('../golden/agent-scenarios.yaml'),
  queriesFile: here('../golden/queries.yaml'),
  phrasesFile: here('../golden/phrases.yaml'),
  surface: `${here('./fixtures/surface.yaml')}#proposed`,
  catalogCommand: [process.execPath, '-e', ''],
  cliCommand: [process.execPath, '-e', ''],
  claude: [process.execPath, here('./fixtures/fake-claude.mjs')],
  models: ['claude-haiku-4-5-20251001'],
  tries: 1,
  out: m.out,
  machine: m,
  productRepo: null,
});

describe('agent scenario runner (fake claude)', () => {
  it('runs a scenario in each setup: sandbox, MCP config, companion skill, trace, scores, report; leaves nothing behind', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const calls: Record<string, any> = {};
    const report = await runScenarios({
      ...base(m), scenarios: ['A1'], setups: ['mcp', 'mcp+skill', 'skill+cli'],
      beforeTry: (t) => { process.env.QA_FAKE_CLAUDE_RECORD = join(m.out, `${t.setup}.call.json`); },
      afterTry: (t) => { calls[t.setup] = JSON.parse(readFileSync(join(m.out, `${t.setup}.call.json`), 'utf8')); },
    });
    expect(report.runs.map((r) => [r.scenario, r.setup, r.outcome])).toEqual([['A1', 'mcp', 'pass'], ['A1', 'mcp+skill', 'pass'], ['A1', 'skill+cli', 'pass']]);
    expect(report.runs.every((r) => r.differences.length === 0)).toBe(true);

    const mcp = calls.mcp;
    expect(mcp.cwd).toMatch(/skills-catalog-qa\/.+\/work$/);
    expect(mcp.env).toMatchObject({ SKILLS_SYNC_ON_START: '0', SKILLS_AS: 'me' });
    expect(mcp.env.SKILLS_HOME.startsWith(mcp.cwd.replace(/work$/, ''))).toBe(true);
    expect(Object.keys(mcp.mcp.mcpServers)).toEqual(['skills-catalog', 'qa-person']);
    expect(mcp.mcp.mcpServers['skills-catalog'].env.SKILLS_HOME).toBe(mcp.env.SKILLS_HOME);
    expect(mcp.argv.slice(0, 2)).toEqual(['-p', 'Is there a skill for writing release notes?']);
    expect(mcp.argv).toContain('mcp__qa-person__answer');   // the QA plan §3.2's name
    expect(mcp.skill).toBeNull();
    expect(calls['mcp+skill'].skill).toContain('name: shared-skills');
    expect(calls['skill+cli'].skill).toContain('skills-catalog search');
    expect(Object.keys(calls['skill+cli'].mcp.mcpServers)).toEqual(['qa-person']);
    expect(calls['skill+cli'].path0).toMatch(/\/bin$/);
    expect(calls['skill+cli'].shims).toEqual(['skills-catalog']);   // named after the surface's CLI

    for (const r of report.runs) {
      expect(existsSync(r.trace), r.trace).toBe(true);
      expect(existsSync(r.sandbox)).toBe(false);
    }
    const saved = JSON.parse(readFileSync(join(m.out, 'report.json'), 'utf8'));
    expect(saved.summary).toEqual([
      expect.objectContaining({ scenario: 'A1', setup: 'mcp', model: 'claude-haiku-4-5-20251001', verdict: 'pass', tries: 1 }),
      expect.objectContaining({ setup: 'mcp+skill', verdict: 'pass' }),
      expect.objectContaining({ setup: 'skill+cli', verdict: 'pass' }),
    ]);
    expect(readFileSync(join(m.out, 'summary.txt'), 'utf8')).toMatch(/A1 +mcp +haiku +pass/);
    expect(readdirSync(join(m.tmp, 'skills-catalog-qa'))).toEqual([]);
    expect(report.runs.every((r) => RUN_ID.test(basename(r.sandbox)))).toBe(true);   // every try's sandbox is named by a run id
  }, 30_000);   // several tries, each with its before/after check (processes and ports included)

  it('stops the matrix on a harness error (not logged in)', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'not-logged-in.jsonl');
    const report = await runScenarios({ ...base(m), scenarios: ['A1', 'A2'], setups: ['mcp'] });
    expect(report.runs).toHaveLength(1);
    expect(report.stopped).toBe('not_logged_in');
  });

  it('the discovery asks are A1, A2, A3, A3g, A11 and A13 (the QA plan)', async () => {
    const { DISCOVERY } = await import('../src/agent/runner.ts');
    expect([...DISCOVERY].sort()).toEqual(['A1', 'A11', 'A13', 'A2', 'A3', 'A3g']);
  });

  it('five tries for Haiku on the discovery asks, three otherwise, unless --tries says', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const report = await runScenarios({ ...base(m), tries: undefined, scenarios: ['A1'], setups: ['mcp'], models: ['claude-haiku-4-5-20251001', 'claude-opus-5-5'] });
    expect(report.summary.map((s) => [s.model, s.tries])).toEqual([['claude-haiku-4-5-20251001', 5], ['claude-opus-5-5', 3]]);
  }, 30_000);   // several tries, each with its before/after check (processes and ports included)

  it('skips a scenario whose starting catalog needs the catalog code, saying why', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const report = await runScenarios({ ...base(m), scenarios: ['A4'], setups: ['mcp'] });
    expect(report.runs).toEqual([]);
    expect(report.skipped).toEqual([{ scenario: 'A4', why: expect.stringMatching(/histories\.h1@v4.*slice 1/) }]);
  });
});

describe('agent scenario runner: safety of the round', () => {
  it('a try that leaves something behind fails, and so does its scenario, whatever the other rules say', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.dir, 'haiku-mcp-only-direct.jsonl');
    process.env.QA_FAKE_CLAUDE_LEAK = join(m.roots.claudeDir, 'skills', 'leaked-by-the-assistant');
    const report = await runScenarios({ ...base(m), scenarios: ['A1'], setups: ['mcp'] });
    expect(report.runs[0].outcome).toBe('fail');
    expect(report.runs[0].rules).toContainEqual({ name: 'nothing_left_behind', kind: 'safety', ok: false, why: expect.stringContaining('leaked-by-the-assistant') });
    expect(report.summary[0].verdict).toBe('fail');
    expect(readFileSync(join(m.out, 'summary.txt'), 'utf8')).toMatch(/left behind: added folder .*leaked-by-the-assistant/);
  });

  it('every try carries the nothing_left_behind safety rule, true when nothing changed', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.dir, 'haiku-mcp-only-direct.jsonl');
    const report = await runScenarios({ ...base(m), scenarios: ['A1'], setups: ['mcp'] });
    expect(report.runs[0].rules).toContainEqual({ name: 'nothing_left_behind', kind: 'safety', ok: true });
  });

  it('an interrupted round kills the assistant\'s process group, tears the try down and stops', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.dir, 'haiku-mcp-only-direct.jsonl');
    process.env.QA_FAKE_CLAUDE_SLEEP_MS = '30000';
    const pidFile = process.env.QA_FAKE_CLAUDE_PID = join(m.dir, 'fake.pid');
    const stop = new AbortController();
    const t0 = Date.now();
    const pending = runScenarios({ ...base(m), scenarios: ['A1', 'A2'], setups: ['mcp'], signal: stop.signal });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((ok) => setTimeout(ok, 50));
    stop.abort();
    const report = await pending;
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(report.stopped).toBe('interrupted');
    expect(report.runs).toHaveLength(1);
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow();
    expect(readdirSync(join(m.tmp, 'skills-catalog-qa'))).toEqual([]);
  });

  it('a try whose assistant crashes is torn down all the same', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.dir, 'haiku-mcp-only-direct.jsonl');
    process.env.QA_FAKE_CLAUDE_CRASH = '1';
    const report = await runScenarios({ ...base(m), scenarios: ['A1', 'A2'], setups: ['mcp'] });
    expect(report.runs[0]).toMatchObject({ outcome: 'harness_error', harness: { action: 'stop_the_matrix' } });
    expect(report.runs).toHaveLength(1);                                           // the round stops
    expect(readdirSync(join(m.tmp, 'skills-catalog-qa'))).toEqual([]);
  });

  it('refuses unknown scenario and setup names before anything runs', async () => {
    const m = machine();
    await expect(runScenarios({ ...base(m), scenarios: ['A1', 'A99'], setups: ['mcp'] })).rejects.toThrow(/unknown scenario A99/);
    await expect(runScenarios({ ...base(m), scenarios: ['A1'], setups: ['mcp-only'] })).rejects.toThrow(/unknown setup mcp-only/);
  });
});

describe('agent scenario runner: asks from the surface', () => {
  it('fails a run whose ask leaves a placeholder unfilled, without calling the assistant', async () => {
    const m = machine();
    process.env.QA_FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const doc = parse(readFileSync(here('../golden/agent-scenarios.yaml'), 'utf8'));
    doc.scenarios.find((s: any) => s.id === 'A1').ask = 'surface:setup.broken';
    const file = join(m.out.replace(/out$/, ''), 'scenarios.yaml');
    writeFileSync(file, stringify(doc));
    const report = await runScenarios({ ...base(m), scenariosFile: file, scenarios: ['A1'], setups: ['mcp'] });
    expect(report.runs[0]).toMatchObject({ outcome: 'fail', rules: [{ name: 'ask_filled', ok: false, why: '${nope}' }] });
    expect(report.runs[0].metrics.cost_usd).toBe(0);
  });
});
