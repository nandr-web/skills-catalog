// No secrets reach a run (the QA plan §6 step 3, requirement qa-no-secrets-in-runs): every process a run starts (the
// command, the assistant, the MCP servers it starts) gets only an allow-listed environment, and the runner plants a
// marker under the usual secret names to prove it. The assistant keeps the real HOME (its login lives there).
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runScenarios } from '../src/agent/runner.ts';
import { qaRun } from '../src/run.ts';
import { childEnv, ENV_ALLOW, PLANTED_NAMES } from '../src/sandbox.ts';
import { cleanup, PROCESS_TEST_MS, machine, scratch } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const SECRETS = ['AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'NPM_TOKEN', 'SSH_AUTH_SOCK'];
// macOS itself adds __CF_USER_TEXT_ENCODING (the text encoding id) to every process it starts; it is no secret.
const OS_ADDED = ['__CF_USER_TEXT_ENCODING'];
// A child may also carry the sandbox's own SKILLS_* settings (never the parent's).
const allowed = (name: string) => OS_ADDED.includes(name) || name.startsWith('SKILLS_') || ENV_ALLOW.some((a) => (a.endsWith('*') ? name.startsWith(a.slice(0, -1)) : name === a));
// The product's own settings a developer may have exported: they must not reach the product under test or the assistant.
const PARENT_SKILLS = ['SKILLS_TOKEN', 'SKILLS_ACCEPT_FLAGGED_UPDATES'];
const saved = { ...process.env };
afterEach(() => {
  cleanup();
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
});
const plant = () => { for (const k of [...SECRETS, 'MY_NOTES', ...PARENT_SKILLS]) process.env[k] = `QA-PLANT-${k}`; };
const clean = (env: Record<string, string>, where: string) => {
  expect(Object.values(env).filter((v) => v.includes('QA-PLANT')), where).toEqual([]);
  expect(Object.keys(env).filter((k) => !allowed(k)), where).toEqual([]);
  for (const k of PARENT_SKILLS) expect(env[k], `${where}: ${k}`).toBeUndefined();
};

describe('the environment a run\'s processes get', () => {
  it('childEnv keeps exactly the allow-list from the parent, and SKILLS_* only from the sandbox', () => {
    const parent: Record<string, string> = {
      PATH: '/usr/bin', HOME: '/Users/me', USER: 'me', LOGNAME: 'me', SHELL: '/bin/zsh', TMPDIR: '/tmp/x', LANG: 'en_US.UTF-8', LC_CTYPE: 'UTF-8', TERM: 'xterm',
      MY_NOTES: 'x', SKILLS_AS: 'parent', SKILLS_TOKEN: 'QA-PLANT-SKILLS_TOKEN', SKILLS_ACCEPT_FLAGGED_UPDATES: '1', QA_OTHER: 'kept',
      ...Object.fromEntries(SECRETS.map((k) => [k, `QA-PLANT-${k}`])),
    };
    const env = childEnv({ env: { SKILLS_AS: 'me', SKILLS_HOME: '/run/home', SKILLS_MANAGED_SETTINGS: '/run/managed', QA_SANDBOX: '/run', QA_RUN_ID: 'r', PATH: '/run/bin:/usr/bin' } }, parent);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'LANG', 'LC_CTYPE', 'LOGNAME', 'PATH', 'QA_OTHER', 'QA_RUN_ID', 'QA_SANDBOX', 'SHELL', 'SKILLS_AS', 'SKILLS_HOME', 'SKILLS_MANAGED_SETTINGS', 'TERM', 'TMPDIR', 'USER']);
    expect(env).toMatchObject({ HOME: '/Users/me', SKILLS_AS: 'me', PATH: '/run/bin:/usr/bin' });
    expect(ENV_ALLOW).toEqual(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_*', 'TERM', 'QA_*']);   // SKILLS_*: the sandbox's only
    expect(PLANTED_NAMES).toEqual([...SECRETS, 'MY_NOTES']);   // the credential names, and an ordinary one
  });

  // Contract §8: the product reads Claude Code's managed settings (machine-wide policy) unless SKILLS_MANAGED_SETTINGS points
  // elsewhere, so no process of a run starts without it pointing into the run's sandbox.
  it('childEnv refuses a sandbox whose managed settings aren\'t pointed inside it', () => {
    const base = { SKILLS_HOME: '/run/home', QA_SANDBOX: '/run', PATH: '/usr/bin' };
    for (const managed of [undefined, '', '/Library/Application Support/ClaudeCode', '/etc/claude-code', '/run/../etc/claude-code', '/run', 'managed', '/runner/managed']) {
      const env = managed === undefined ? base : { ...base, SKILLS_MANAGED_SETTINGS: managed };
      expect(() => childEnv({ env }, {}), String(managed)).toThrow(/SKILLS_MANAGED_SETTINGS/);
    }
    expect(() => childEnv({ env: { SKILLS_MANAGED_SETTINGS: '/run/managed', PATH: '/usr/bin' } }, {}), 'no sandbox named').toThrow(/SKILLS_MANAGED_SETTINGS/);
    expect(childEnv({ env: { ...base, SKILLS_MANAGED_SETTINGS: '/run/managed' } }, {}).SKILLS_MANAGED_SETTINGS).toBe('/run/managed');
  });

  // By path alone, a link in the sandbox would pass and the product would read through it. A link whose target exists is
  // followed and found outside; one whose target isn't there yet (it could be made later) is refused as a link.
  it('childEnv refuses managed settings reached through a link in the sandbox, whether or not its target exists yet', () => {
    const root = scratch(), outside = scratch();
    const env = (managed: string) => ({ env: { QA_SANDBOX: root, PATH: '/usr/bin', SKILLS_MANAGED_SETTINGS: managed } });
    symlinkSync(outside, join(root, 'managed'));
    symlinkSync(join(outside, 'not-yet'), join(root, 'later'));
    mkdirSync(join(root, 'real'));
    symlinkSync(join(outside, 'not-yet-either'), join(root, 'real', 'managed'));
    for (const managed of [join(root, 'managed'), join(root, 'managed', 'deeper'), join(root, 'later'), join(root, 'later', 'managed'), join(root, 'real', 'managed')]) {
      expect(() => childEnv(env(managed), {}), managed).toThrow(/SKILLS_MANAGED_SETTINGS/);
    }
    mkdirSync(join(root, 'plain'));
    expect(childEnv(env(join(root, 'plain', 'managed')), {}).SKILLS_MANAGED_SETTINGS).toBe(join(root, 'plain', 'managed'));
  });

  it('qa run: the command sees no secret and no name outside the allow-list', async () => {
    const m = machine();
    plant();
    const out = join(m.dir, 'env.json');
    const r = await qaRun({ machine: m, command: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`], productRepo: null });
    expect(r.status).toBe('pass');
    clean(JSON.parse(readFileSync(out, 'utf8')), 'the command');
  });

  it('the agent runner: the assistant and the MCP servers it starts from the run\'s mcp.json see no secret; the planted marker never shows', async () => {
    const m = machine();
    plant();
    const trace = join(m.dir, 'trace.jsonl');
    writeFileSync(trace, readFileSync(here('../fixtures/traces/haiku-mcp-only-direct.jsonl'), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills'));
    const assistantEnv = join(m.dir, 'assistant-env.json'), serverEnv = join(m.dir, 'server-env.json');
    Object.assign(process.env, { QA_FAKE_CLAUDE_TRACE: trace, QA_FAKE_CLAUDE_ENV_OUT: assistantEnv, QA_FAKE_CLAUDE_START_MCP: '1' });
    const report = await runScenarios({
      scenariosFile: here('../golden/agent-scenarios.yaml'), queriesFile: here('../golden/queries.yaml'), phrasesFile: here('../golden/phrases.yaml'),
      surface: `${here('./fixtures/surface.yaml')}#proposed`,
      catalogCommand: ['env', `QA_FAKE_MCP_ENV_OUT=${serverEnv}`, process.execPath, here('./fixtures/fake-mcp.mjs')],
      claude: [process.execPath, here('./fixtures/fake-claude.mjs')], models: ['claude-haiku-4-5-20251001'], tries: 1, out: join(m.dir, 'out'),
      scenarios: ['A1'], setups: ['mcp'], machine: m, productRepo: null,
    });
    expect(existsSync(assistantEnv) && existsSync(serverEnv)).toBe(true);
    clean(JSON.parse(readFileSync(assistantEnv, 'utf8')), 'the assistant');
    clean(JSON.parse(readFileSync(serverEnv, 'utf8')), 'the catalog MCP server');
    expect(JSON.parse(readFileSync(assistantEnv, 'utf8')).HOME).toBe(process.env.HOME);   // the one documented exception: its login lives there
    expect(report.runs[0].rules).toContainEqual({ name: 'no_env_marker_in', kind: 'safety', ok: true });
  }, 30_000);
});
