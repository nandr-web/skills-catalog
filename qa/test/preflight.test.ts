// Pre-flight before any live run (brief §2.7): the unit tests pass; every variant renders with nothing unfilled; the
// catalog server's self-test passes (MCP initialize and tools/list, every allowed tool there); one login probe works.
// The unit-test step is skipped here (it would run this suite inside itself); `qa agent` runs it.
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { readFileSync } from 'node:fs';
import { preflight } from '../src/agent/preflight.ts';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, machine, scratch, type TestMachine } from './machine.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
afterEach(() => { cleanup(); delete process.env.QA_FAKE_CLAUDE_TRACE; });
const machines = new Map<string, TestMachine>();
const dir = () => { const m = machine(); const d = scratch('qa-pre-'); machines.set(d, m); return d; };

let written = 0;
const TOOLS = ['search_shared_skills', 'read_shared_skill', 'list_shared_skill_versions', 'diff_shared_skill_versions', 'install_shared_skill', 'list_installed_skills', 'update_installed_skills'];
function scenarios(d: string, over: (doc: any) => void = () => {}) {
  const doc = parse(readFileSync(here('../golden/agent-scenarios.yaml'), 'utf8'));
  doc.setups['skill+cli'].allowed = ['Bash(${cli} *)', 'Skill'];
  over(doc);
  const p = join(d, `scenarios-${++written}.yaml`);   // a file per call: opts() writes the defaults too
  writeFileSync(p, stringify(doc));
  return p;
}
const opts = (d: string, extra: Record<string, unknown> = {}) => ({
  qaDir: here('..'), skipTests: true,
  scenariosFile: scenarios(d), surfaceFile: here('./fixtures/surface.yaml'), variant: 'proposed',
  catalogCommand: ['env', `FAKE_MCP_TOOLS=${JSON.stringify(TOOLS)}`, process.execPath, here('./fixtures/fake-mcp.mjs')],
  claude: [process.execPath, here('./fixtures/fake-claude.mjs')],
  machine: machines.get(d)!,
  ...extra,
});
const ok = () => { process.env.QA_FAKE_CLAUDE_TRACE = here('../fixtures/traces/opus-direct.jsonl'); };

describe('pre-flight', () => {
  it('passes when everything renders, the server lists every allowed tool and the login probe works', async () => {
    const d = dir(); ok();
    expect(await preflight(opts(d))).toEqual([]);
  });

  it('flags an ask left with an unfilled placeholder', async () => {
    const d = dir(); ok();
    const p = scenarios(d, (doc) => { doc.scenarios[0].ask = 'surface:setup.broken'; });
    expect(await preflight(opts(d, { scenariosFile: p }))).toEqual([   // every variant is checked, not only the one that runs
      expect.stringMatching(/^A1: the ask leaves \$\{nope\} unfilled \(control\)/), expect.stringMatching(/^A1: the ask leaves \$\{nope\} unfilled \(proposed\)/),
    ]);
  });

  it('starts the catalog\'s server exactly as the runs do (from the run\'s own mcp.json): a moved server path fails', async () => {
    const d = dir(); ok();
    const moved = ['env', `FAKE_MCP_TOOLS=${JSON.stringify(TOOLS)}`, process.execPath, join(d, 'moved-away', 'fake-mcp.mjs')];
    expect((await preflight(opts(d, { catalogCommand: moved })))[0]).toMatch(/^server self-test: .*catalog/);
  });

  it('gives the server only the allow-listed environment, the runs\' own', async () => {
    const d = dir(); ok();
    const out = join(d, 'server-env.json');
    process.env.AWS_SECRET_ACCESS_KEY = 'QA-PLANT-AWS';
    try {
      const cmd = ['env', `FAKE_MCP_TOOLS=${JSON.stringify(TOOLS)}`, `QA_FAKE_MCP_ENV_OUT=${out}`, process.execPath, here('./fixtures/fake-mcp.mjs')];
      expect(await preflight(opts(d, { catalogCommand: cmd }))).toEqual([]);
      const env = JSON.parse(readFileSync(out, 'utf8'));
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(env.SKILLS_HOME).toMatch(/skills-catalog-qa\/.+\/home$/);
    } finally { delete process.env.AWS_SECRET_ACCESS_KEY; }
  });

  it('refuses a round whose scenarios use a rule the scorer doesn\'t know (a typo), before anything is spent', async () => {
    const d = dir(); ok();
    const p = scenarios(d, (doc) => { doc.scenarios.find((s: any) => s.id === 'A1').expect.push({ answer_containz: 'release' }); });
    expect(await preflight(opts(d, { scenariosFile: p }))).toEqual([expect.stringMatching(/A1: answer_containz.*isn't a rule the scorer knows/)]);
    expect(await preflight(opts(d, { scenariosFile: p, scenarios: ['A2'] }))).toEqual([]);   // only the chosen scenarios count
  });

  it('flags an allowed CLI rule that doesn\'t match the surface\'s CLI name', async () => {
    const d = dir(); ok();
    const p = scenarios(d, (doc) => { doc.setups['skill+cli'].allowed = ['Bash(skills *)', 'Skill']; });
    expect(await preflight(opts(d, { scenariosFile: p }))).toEqual([expect.stringMatching(/skill\+cli allows Bash\(skills \*\), but the CLI is skills-catalog/)]);
  });

  it('flags a tool the setups allow but the server doesn\'t list', async () => {
    const d = dir(); ok();
    const cmd = ['env', `FAKE_MCP_TOOLS=${JSON.stringify(TOOLS.filter((t) => t !== 'install_shared_skill'))}`, process.execPath, here('./fixtures/fake-mcp.mjs')];
    expect(await preflight(opts(d, { catalogCommand: cmd }))).toEqual([expect.stringMatching(/server self-test: no tool install_shared_skill/)]);
  });

  it('flags a server that doesn\'t start', async () => {
    const d = dir(); ok();
    expect((await preflight(opts(d, { catalogCommand: [process.execPath, '-e', 'process.exit(1)'] })))[0]).toMatch(/^server self-test:/);
  });

  it('flags a login probe that isn\'t logged in', async () => {
    const d = dir();
    process.env.QA_FAKE_CLAUDE_TRACE = here('../fixtures/traces/not-logged-in.jsonl');
    expect(await preflight(opts(d))).toEqual(['login probe: not_logged_in (run /login in Claude Code, then try again)']);
    expect(readdirSync(sandboxBase(machines.get(d)!.tmp))).toEqual([]);   // its sandbox is gone, on the fake machine
  });
});
