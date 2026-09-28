// Pre-flight before any live run (brief §2.7): the unit tests pass; every variant renders with nothing unfilled; the
// catalog server's self-test passes (MCP initialize and tools/list, every allowed tool there); one login probe works.
// The unit-test step is skipped here (it would run this suite inside itself); `qa agent` runs it.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { readFileSync } from 'node:fs';
import { preflight } from '../src/agent/preflight.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); delete process.env.FAKE_CLAUDE_TRACE; });
const dir = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'qa-pre-'))); made.push(d); return d; };

let written = 0;
const TOOLS = ['search_shared_skills', 'read_shared_skill', 'list_shared_skill_versions', 'diff_shared_skill_versions', 'install_shared_skill', 'list_installed_skills'];
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
  ...extra,
});
const ok = () => { process.env.FAKE_CLAUDE_TRACE = here('../fixtures/traces/opus-direct.jsonl'); };

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
    process.env.FAKE_CLAUDE_TRACE = here('../fixtures/traces/not-logged-in.jsonl');
    expect(await preflight(opts(d))).toEqual(['login probe: not_logged_in (run /login in Claude Code, then try again)']);
  });
});
