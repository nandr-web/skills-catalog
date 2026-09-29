// The agent scenario runner's parts (brief §2.1-2.3): the surface variant (tool names, companion skill), the exact
// `claude -p` command per setup (qa-plan §3.2), and the stand-in person, a QA MCP tool that answers permission prompts.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSurface } from '../src/agent/surface.ts';
import { claudeCommand, mcpConfig, SETUPS_FROM } from '../src/agent/command.ts';

const SURFACE = fileURLToPath(new URL('./fixtures/surface.yaml', import.meta.url));
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('surface', () => {
  it('maps contract operations to the variant\'s tool names, and back', () => {
    const s = loadSurface(`${SURFACE}#proposed`);
    expect(s.tool('search')).toBe('mcp__skills-catalog__search_shared_skills');
    expect(s.tool('publish_skill_to_catalog')).toBe('mcp__skills-catalog__publish_skill_to_catalog');
    // a scenario may name an operation by any contract version's name, or by its key
    expect(s.tool('install_skill')).toBe('mcp__skills-catalog__install_shared_skill');
    expect(s.tool('get')).toBe('mcp__skills-catalog__read_shared_skill');
    expect(s.key('read')).toBeUndefined();   // no alias: the goldens use the surface's keys (the QA plan)
    expect(s.names().ops.install_shared_skill).toEqual(['mcp__skills-catalog__install_shared_skill', 'skills-catalog install']);
    expect(s.names().ops.search_shared_skills).toEqual(['mcp__skills-catalog__search_shared_skills', 'skills-catalog search']);
    expect(s.names().ops.setup).toEqual(['mcp__skills-catalog__setup', 'skills-catalog setup']);
    expect(s.names().ops.teardown).toEqual(['mcp__skills-catalog__teardown', 'skills-catalog teardown']);   // A14
    expect(s.cli).toBe('skills-catalog');
  });

  it('fills the companion skill with the variant\'s tool names', () => {
    const s = loadSurface(`${SURFACE}#control`);
    expect(s.companionSkill('mcp')).toContain('Search with `search_shared_skills`, install with `install_skill`.');
    expect(s.companionSkill('cli')).toContain('skills-catalog search <words>');
  });

  it('takes an ask from the surface, filled with the variant\'s names, and finds anything left unfilled', () => {
    const s = loadSurface(`${SURFACE}#proposed`);
    expect(s.ask('surface:setup.handoff_prompt_fast')).toBe("Set up our team's Skills Catalog on this machine with the defaults: run `skills-catalog setup --yes`.");
    expect(s.ask('Is there a skill for X?')).toBe('Is there a skill for X?');
    expect(() => s.ask('surface:setup.missing')).toThrow(/setup\.missing/);
    expect(s.unfilled(s.ask('surface:setup.broken'))).toEqual(['${nope}']);
    expect(s.unfilled(s.ask('surface:setup.handoff_prompt'))).toEqual([]);
  });

  it('fills ${cli} in an allowed entry', () => {
    const s = loadSurface(`${SURFACE}#proposed`);
    const setups = SETUPS_FROM({ 'skill+cli': { mcp: false, allowed: ['Bash(${cli} *)', 'Skill'], companion_skill: true, cli_on_path: true } });
    const cmd = claudeCommand({ ask: 'x', model: 'm', setup: setups['skill+cli'], surface: s, mcpConfig: '/c', budgetUsd: 0.25 });
    expect(cmd).toContain('Bash(skills-catalog *),Skill');
  });

  it('refuses an unknown variant, naming the ones it has', () => {
    expect(() => loadSurface(`${SURFACE}#nope`)).toThrow(/control, proposed/);
  });
});

describe('the claude -p command (qa-plan §3.2)', () => {
  const surface = loadSurface(`${SURFACE}#proposed`);
  const setups = SETUPS_FROM({
    mcp: { mcp: true, allowed: ['get', 'search', 'install'], companion_skill: false, cli_on_path: false },
    'mcp+skill': { mcp: true, allowed: ['search', 'Skill'], companion_skill: true, cli_on_path: false },
    'skill+cli': { mcp: false, allowed: ['Bash(skills *)', 'Skill'], companion_skill: true, cli_on_path: true },
  });
  const base = { ask: 'Is there a skill for writing release notes?', model: 'claude-haiku-4-5-20251001', mcpConfig: '/run/mcp.json', surface, budgetUsd: 0.25 };

  it('built-in tools stay on; the setup\'s tools are allowed; the rest goes to the stand-in person', () => {
    expect(claudeCommand({ ...base, setup: setups.mcp })).toEqual(['claude', '-p', 'Is there a skill for writing release notes?',
      '--model', 'claude-haiku-4-5-20251001', '--no-session-persistence', '--setting-sources', 'project',
      '--permission-prompt-tool', 'mcp__qa-person__answer', '--permission-prompts', 'host',
      '--max-budget-usd', '0.25', '--strict-mcp-config', '--mcp-config', '/run/mcp.json',
      '--allowedTools', 'mcp__skills-catalog__read_shared_skill,mcp__skills-catalog__search_shared_skills,mcp__skills-catalog__install_shared_skill',
      '--output-format', 'stream-json', '--verbose']);
    expect(claudeCommand({ ...base, setup: setups['skill+cli'] })).toContain('Bash(skills *),Skill');   // as written; pre-flight flags the mismatch
    expect(claudeCommand({ ...base, setup: setups['mcp+skill'] })).toContain('mcp__skills-catalog__search_shared_skills,Skill');
  });

  it('the fallback: dontAsk instead of the stand-in person, with the agreed operations allowed', () => {
    const cmd = claudeCommand({ ...base, setup: setups.mcp, fallback: { agreesTo: ['publish_skill_to_catalog'] } });
    expect(cmd).toContain('dontAsk');
    expect(cmd).not.toContain('--permission-prompt-tool');
    expect(cmd.join(' ')).toContain('mcp__skills-catalog__publish_skill_to_catalog');
  });

  it('writes the MCP config: the catalog server (setups with MCP) and the stand-in person, both with the sandbox settings', () => {
    const env = { SKILLS_HOME: '/run/home', SKILLS_SYNC_ON_START: '0' };
    const cfg = mcpConfig({ setup: setups.mcp, surface, catalog: ['uv', 'run', 'mock', 'serve'], env, person: { agreesTo: ['publish_skill_to_catalog'], log: '/run/person.jsonl' } });
    expect(Object.keys(cfg.mcpServers)).toEqual(['skills-catalog', 'qa-person']);
    expect(cfg.mcpServers['skills-catalog']).toEqual({ command: 'uv', args: ['run', 'mock', 'serve'], env });
    expect(cfg.mcpServers['qa-person'].env).toMatchObject({ QA_PERSON_LOG: '/run/person.jsonl', QA_PERSON_AGREES: JSON.stringify(['mcp__skills-catalog__publish_skill_to_catalog']) });
    expect(Object.keys(mcpConfig({ setup: setups['skill+cli'], surface, catalog: ['x'], env, person: { agreesTo: [], log: '/l' } }).mcpServers)).toEqual(['qa-person']);
  });

  it('the stand-in person may agree only to the catalog\'s MCP tools, never to a built-in tool or a shell command', () => {
    const env = { SKILLS_HOME: '/run/home' };
    for (const agreed of [['Bash(rm *)'], ['Write'], ['publish_skill_to_catalog', 'Edit']])
      expect(() => mcpConfig({ setup: setups.mcp, surface, catalog: ['x'], env, person: { agreesTo: agreed, log: '/l' } }), agreed.join()).toThrow(/only .*catalog/);
    expect(() => claudeCommand({ ...base, setup: setups.mcp, fallback: { agreesTo: ['Bash(rm *)'] } })).toThrow(/only .*catalog/);
  });
});

describe('the stand-in person (a QA MCP server over stdio)', () => {
  it('approves only what the scenario agrees to, refuses the rest, and records every request', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-person-')));
    made.push(dir);
    const log = join(dir, 'person.jsonl');
    const server = fileURLToPath(new URL('../src/agent/person.ts', import.meta.url));
    const p = spawn(process.execPath, [server], { env: { ...process.env, QA_PERSON_LOG: log, QA_PERSON_AGREES: JSON.stringify(['mcp__skills-catalog__publish_skill_to_catalog']) }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies: any[] = [];
    let buf = '';
    p.stdout.on('data', (b) => { buf += b; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const send = (m: object) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
    const reply = (id: number) => new Promise<any>((ok) => { const t = setInterval(() => { const r = replies.find((x) => x.id === id); if (r) { clearInterval(t); ok(r); } }, 5); });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    expect((await reply(1)).result.serverInfo.name).toBe('qa-person');
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    expect((await reply(2)).result.tools.map((t: any) => t.name)).toEqual(['answer']);
    const ask = (id: number, tool_name: string) => { send({ id, method: 'tools/call', params: { name: 'answer', arguments: { tool_name, input: { folder: './x' } } } }); return reply(id); };
    expect(JSON.parse((await ask(3, 'mcp__skills-catalog__publish_skill_to_catalog')).result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { folder: './x' } });
    expect(JSON.parse((await ask(4, 'Bash')).result.content[0].text)).toMatchObject({ behavior: 'deny' });
    p.stdin.end();
    await new Promise((ok) => p.on('exit', ok));
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))).toMatchObject([
      { tool_name: 'mcp__skills-catalog__publish_skill_to_catalog', decision: 'allow' },
      { tool_name: 'Bash', decision: 'deny' },
    ]);
  });
});
