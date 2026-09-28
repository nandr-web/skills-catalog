// Pre-flight before any live run (qa-plan §6.7a; brief §2.7): the unit tests pass; every variant renders with nothing
// unfilled; the catalog server's self-test passes; one login probe works. Returns the problems; a live round starts only
// when there are none, so a broken harness never spends money or produces runs that count as a pass or a fail.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { createSandbox, recordSession } from '../sandbox.ts';
import { teardown } from '../teardown.ts';
import { newRunId } from '../run.ts';
import { connect } from './mcp-client.ts';
import { loadSurface } from './surface.ts';
import { parseTrace } from './trace.ts';
import { score } from './score.ts';
import { loadPhrases } from './phrases.ts';

export type PreflightOptions = {
  qaDir: string; scenariosFile: string; surfaceFile: string; variant: string; catalogCommand: string[];
  claude?: string[]; skipTests?: boolean; skipLogin?: boolean;
};

export async function preflight(o: PreflightOptions): Promise<string[]> {
  const problems: string[] = [];
  const doc = parse(readFileSync(o.scenariosFile, 'utf8'));
  const surfaceDoc = parse(readFileSync(o.surfaceFile, 'utf8'));

  // 1. The unit tests (live tests stay off: QA_LIVE is removed).
  if (!o.skipTests) {
    const env = { ...process.env }; delete env.QA_LIVE;
    const r = spawnSync('npx', ['vitest', 'run'], { cwd: o.qaDir, env, encoding: 'utf8' });
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
  const run = loadSurface(`${o.surfaceFile}#${o.variant}`);
  for (const [name, setup] of Object.entries(doc.setups as Record<string, { allowed: string[]; mcp: boolean }>)) {
    for (const a of setup.allowed) {
      const m = run.fill(a).match(/^Bash\((\S+) \*\)$/);
      if (m && m[1] !== run.cli) problems.push(`setup ${name} allows ${a}, but the CLI is ${run.cli}: every CLI call would go to the stand-in person`);
    }
  }

  // 3. The catalog server's self-test: it starts, answers initialize, and lists every tool the MCP setups allow.
  const wanted = [...new Set(Object.values(doc.setups as Record<string, { allowed: string[]; mcp: boolean }>).filter((s) => s.mcp)
    .flatMap((s) => s.allowed).filter((a) => run.key(a)).map((a) => run.tool(a).replace(`mcp__${run.server}__`, '')))];
  const sb = createSandbox({ runId: `${newRunId()}-preflight` });
  try {
    const client = await connect(o.catalogCommand, sb.env);
    try {
      const listed = new Set(((await client.request('tools/list')).tools ?? []).map((t: { name: string }) => t.name));
      for (const t of wanted) if (!listed.has(t)) problems.push(`server self-test: no tool ${t} (variant ${o.variant})`);
    } finally { client.close(); }
  } catch (e) {
    problems.push(`server self-test: ${(e as Error).message}`);
  }

  // 4. One login probe: a tiny headless run (Haiku, capped), which must not be a harness error.
  if (!o.skipLogin) {
    const cfg = join(sb.root, 'mcp-none.json');
    writeFileSync(cfg, JSON.stringify({ mcpServers: {} }));
    const argv = [...(o.claude ?? ['claude']), '-p', 'Reply with the single word ok.', '--model', 'claude-haiku-4-5-20251001', '--no-session-persistence',
      '--setting-sources', 'project', '--max-budget-usd', '0.05', '--strict-mcp-config', '--mcp-config', cfg, '--output-format', 'stream-json', '--verbose'];
    const r = spawnSync(argv[0], argv.slice(1), { cwd: sb.dirs.work, env: { ...process.env, ...sb.env }, encoding: 'utf8', timeout: 120_000 });
    const trace = parseTrace(r.stdout ?? '');
    for (const s of trace.sessions) recordSession(sb, s);
    const scored = score(trace, { rules: { expect: [], safety: [] }, names: { ops: {}, server: '' }, phrases: loadPhrases(join(o.qaDir, 'golden', 'phrases.yaml')) });
    if (scored.outcome === 'harness_error') {
      problems.push(`login probe: ${scored.harness!.reason}${scored.harness!.reason === 'not_logged_in' ? ' (run /login in Claude Code, then try again)' : ''}`);
    }
  }
  await teardown(sb);
  return problems;
}
