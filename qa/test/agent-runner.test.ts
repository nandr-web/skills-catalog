// The agent scenario runner end to end (brief §2), with a fake `claude` that replays a recorded trace, so it costs nothing:
// a sandbox per try, the MCP config and companion skill per setup, the trace kept, sessions recorded, teardown and the
// before/after check, scores and the report. Live runs (a real assistant) are in agent-live.test.ts, behind QA_LIVE=1.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenarios } from '../src/agent/runner.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.FAKE_CLAUDE_TRACE; delete process.env.FAKE_CLAUDE_RECORD; });

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-agent-')));
  made.push(root);
  const m = { tmp: join(root, 'tmp'), home: join(root, 'home'), claudeTmp: join(root, 'private-tmp-claude'), out: join(root, 'out') };
  for (const d of [m.tmp, join(m.home, '.claude', 'skills'), join(m.home, '.claude', 'projects'), join(m.home, '.claude', 'session-env'), m.claudeTmp]) mkdirSync(d, { recursive: true });
  return { ...m, machine: { tmp: m.tmp, home: m.home, roots: { claudeDir: join(m.home, '.claude'), claudeTmp: m.claudeTmp }, productDefaults: [join(m.home, '.skills-catalog')], claudeJson: join(m.home, '.claude.json'), settingsJson: join(m.home, '.claude', 'settings.json') } };
}

/** the QA plan's direct-MCP spike trace, with the spike's stand-in tool renamed to this surface's search tool. */
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
  ...m.machine,
});

describe('agent scenario runner (fake claude)', () => {
  it('runs a scenario in each setup: sandbox, MCP config, companion skill, trace, scores, report; leaves nothing behind', async () => {
    const m = machine();
    process.env.FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const calls: Record<string, any> = {};
    const report = await runScenarios({
      ...base(m), scenarios: ['A1'], setups: ['mcp', 'mcp+skill', 'skill+cli'],
      beforeTry: (t) => { process.env.FAKE_CLAUDE_RECORD = join(m.out, `${t.setup}.call.json`); },
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
    expect(mcp.argv).toContain('mcp__qa-person__approve');
    expect(mcp.skill).toBeNull();
    expect(calls['mcp+skill'].skill).toContain('name: shared-skills');
    expect(calls['skill+cli'].skill).toContain('skills search');
    expect(Object.keys(calls['skill+cli'].mcp.mcpServers)).toEqual(['qa-person']);
    expect(calls['skill+cli'].path0).toMatch(/\/bin$/);

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
  });

  it('stops the matrix on a harness error (not logged in)', async () => {
    const m = machine();
    process.env.FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'not-logged-in.jsonl');
    const report = await runScenarios({ ...base(m), scenarios: ['A1', 'A2'], setups: ['mcp'] });
    expect(report.runs).toHaveLength(1);
    expect(report.stopped).toBe('not_logged_in');
  });

  it('five tries for Haiku on the discovery asks, three otherwise, unless --tries says', async () => {
    const m = machine();
    process.env.FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const report = await runScenarios({ ...base(m), tries: undefined, scenarios: ['A1'], setups: ['mcp'], models: ['claude-haiku-4-5-20251001', 'claude-opus-5-5'] });
    expect(report.summary.map((s) => [s.model, s.tries])).toEqual([['claude-haiku-4-5-20251001', 5], ['claude-opus-5-5', 3]]);
  });

  it('skips a scenario whose starting catalog needs the catalog code, saying why', async () => {
    const m = machine();
    process.env.FAKE_CLAUDE_TRACE = traceFile(m.out.replace(/out$/, ''), 'haiku-mcp-only-direct.jsonl');
    const report = await runScenarios({ ...base(m), scenarios: ['A4'], setups: ['mcp'] });
    expect(report.runs).toEqual([]);
    expect(report.skipped).toEqual([{ scenario: 'A4', why: expect.stringMatching(/histories\.h1@v4.*slice 1/) }]);
  });
});
