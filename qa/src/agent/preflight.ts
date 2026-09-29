// Pre-flight before any live run (the QA plan §6.7a; brief §2.7): the assistant is given by its full path and is a copy
// macOS approved (its path and version are reported); the unit tests pass; every variant renders with nothing
// unfilled; every MCP server the runs start passes a self-test, started exactly as the runs start it; one login probe works. Returns the problems; a live round starts only
// when there are none, so a broken harness never spends money or produces runs that count as a pass or a fail.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Machine } from '../machine.ts';
import { childEnv, createSandbox, newRunId } from '../sandbox.ts';
import { teardown } from '../teardown.ts';
import { UnsafeError } from '../safe-delete.ts';
import { assistantVersion, defaultAssistant, resolveAssistant } from './assistant.ts';
import { mcpConfig, SETUPS_FROM } from './command.ts';
import { connect } from './mcp-client.ts';
import { loadSurface } from './surface.ts';
import { parseTrace } from './trace.ts';
import { ruleCheck, score } from './score.ts';
import { loadPhrases } from './phrases.ts';

export type PreflightOptions = {
  qaDir: string; scenariosFile: string; surfaceFile: string; variant: string; catalogCommand: string[];
  claude?: string[];      // the assistant, by its full path (default: the machine's ~/.local/bin/claude)
  skipTests?: boolean; skipLogin?: boolean;
  scenarios?: string[];   // the round's scenarios (default: all), whose rules must be ones the scorer knows
  machine: Machine;
  report?: (line: string) => void;   // what the person should see before a live round: which assistant, which version
};

export async function preflight(o: PreflightOptions): Promise<string[]> {
  const problems: string[] = [];

  // 0. The assistant only by its full path, resolved and checked before anything runs it (assistant.ts).
  let claude: string[] | undefined;
  try {
    claude = resolveAssistant(o.claude ?? defaultAssistant(o.machine));
  } catch (e) {
    if (!(e instanceof UnsafeError)) throw e;
    problems.push(`assistant: ${e.message}`);
  }
  const doc = parse(readFileSync(o.scenariosFile, 'utf8'));
  const surfaceDoc = parse(readFileSync(o.surfaceFile, 'utf8'));

  // 1. The unit tests (the live and real-machine checks stay off: QA_LIVE and QA_REAL are removed).
  if (!o.skipTests) {
    const env = { ...process.env }; delete env.QA_LIVE; delete env.QA_REAL;
    const r = spawnSync('npx', ['--no-install', 'vitest', 'run'], { cwd: o.qaDir, env, encoding: 'utf8' });   // never fetches a package
    if (r.status !== 0) problems.push(`unit tests: failing (run \`npm test\` in ${o.qaDir})`);
  }

  // 2. Every variant renders with nothing unfilled: the asks the scenarios take from the surface, the companion skills,
  //    and the CLI name in the setups' allowed rules.
  for (const variant of Object.keys(surfaceDoc.variants ?? {})) {
    const s = loadSurface(`${o.surfaceFile}#${variant}`);
    for (const sc of doc.scenarios) {
      let ask: string;
      try { ask = s.ask(String(sc.ask)) + (sc.ask_suffix ?? ''); } catch (e) { problems.push(`${sc.id}: ${(e as Error).message} (${variant})`); continue; }
      for (const u of s.unfilled(ask)) problems.push(`${sc.id}: the ask leaves ${u} unfilled (${variant})`);
    }
    for (const kind of ['mcp', 'cli'] as const) {
      if (surfaceDoc.companion_skill?.[kind]) for (const u of s.unfilled(s.companionSkill(kind))) problems.push(`companion skill (${kind}): ${u} unfilled (${variant})`);
    }
  }
  // Every rule the round's scenarios use is one the scorer knows: a typo would otherwise show only after a paid round,
  // with every try incomplete. Rules waiting on a later slice are fine (the CLI lists which scenarios they leave incomplete).
  for (const u of ruleCheck(doc, o.scenarios).unknown) problems.push(`scenario ${u} isn't a rule the scorer knows (a typo in the goldens?)`);
  const run = loadSurface(`${o.surfaceFile}#${o.variant}`);
  for (const [name, setup] of Object.entries(doc.setups as Record<string, { allowed: string[]; mcp: boolean }>)) {
    for (const a of setup.allowed) {
      const m = run.fill(a).match(/^Bash\((\S+) \*\)$/);
      if (m && m[1] !== run.cli) problems.push(`setup ${name} allows ${a}, but the CLI is ${run.cli}: every CLI call would go to the stand-in person`);
    }
  }

  // 3. Every MCP server the runs start, started exactly as they start it: from the run's own mcp.json (the same command,
  //    args and env, in the run's working folder, with the allow-listed environment), so the two can't drift. The
  //    catalog's server answers initialize, lists every tool the MCP setups allow and answers one search; the stand-in
  //    person answers initialize and lists its tool.
  const wanted = [...new Set(Object.values(doc.setups as Record<string, { allowed: string[]; mcp: boolean }>).filter((s) => s.mcp)
    .flatMap((s) => s.allowed).filter((a) => run.key(a)).map((a) => run.tool(a).replace(`mcp__${run.server}__`, '')))];
  const sessionEnvDir = join(o.machine.roots.claudeDir, 'session-env');
  const sessionEnvsBefore = new Set(existsSync(sessionEnvDir) ? readdirSync(sessionEnvDir) : []);
  const sb = createSandbox({ runId: newRunId(), machine: o.machine });
  let sessions: string[] = [];
  try {
    // The assistant's resolved path and version, for the person to see before the round (in the sandbox, with the
    // run's allow-listed environment).
    if (claude) o.report?.(`assistant: ${claude.join(' ')} (${assistantVersion(claude, childEnv(sb))})`);

    const mcpSetup = Object.values(SETUPS_FROM(doc.setups)).find((x) => x.mcp)!;
    const cfgPath = join(sb.root, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify(mcpConfig({ setup: mcpSetup, surface: run, catalog: o.catalogCommand, env: sb.env, person: { agreesTo: [], log: join(sb.root, 'person.jsonl') } }), null, 2));
    const servers = JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers as Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    for (const [name, srv] of Object.entries(servers)) {
      const catalog = name === run.server;
      const label = catalog ? `the catalog's server (${name})` : `the stand-in person (${name})`;
      try {
        const client = await connect([srv.command, ...srv.args], { ...childEnv(sb), ...srv.env }, { cwd: sb.dirs.work });
        try {
          const listed = new Set(((await client.request('tools/list')).tools ?? []).map((t: { name: string }) => t.name));
          if (catalog) {
            for (const t of wanted) if (!listed.has(t)) problems.push(`server self-test: no tool ${t} (variant ${o.variant})`);
            const search = run.tool('search').replace(`mcp__${run.server}__`, '');
            if (listed.has(search)) await client.request('tools/call', { name: search, arguments: { query: 'release notes' } });
          } else if (!listed.has('answer')) problems.push(`server self-test: ${label} has no tool answer`);
        } finally { client.close(); }
      } catch (e) {
        problems.push(`server self-test: ${label}: ${(e as Error).message}`);
      }
    }

    // 4. One login probe: a tiny headless run (Haiku, capped), which must not be a harness error.
    if (!o.skipLogin && claude) {
      const cfg = join(sb.root, 'mcp-none.json');
      writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
      const argv = [...claude, '-p', 'Reply with the single word ok.', '--model', 'claude-haiku-4-5-20251001', '--no-session-persistence',
        '--setting-sources', 'project', '--max-budget-usd', '0.05', '--strict-mcp-config', '--mcp-config', cfg, '--output-format', 'stream-json', '--verbose'];
      const r = spawnSync(argv[0], argv.slice(1), { cwd: sb.dirs.work, env: childEnv(sb), encoding: 'utf8', timeout: 120_000 });
      const trace = parseTrace(r.stdout ?? '');
      sessions = trace.sessions;
      const scored = score(trace, { rules: { expect: [], safety: [] }, names: { ops: {}, server: '' }, phrases: loadPhrases(join(o.qaDir, 'golden', 'phrases.yaml')) });
      if (scored.outcome === 'harness_error') {
        problems.push(`login probe: ${scored.harness!.reason}${scored.harness!.reason === 'not_logged_in' ? ' (run /login in Claude Code, then try again)' : ''}`);
      }
    }
  } finally {
    // the session ids come from the probe's own stream, never from a file in the sandbox
    await teardown(sb, { machine: o.machine, sessions, sessionEnvsBefore });
  }
  return problems;
}
