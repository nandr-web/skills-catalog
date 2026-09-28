// The agent scenario runner (qa-plan §3; brief §2): scenario × setup × model × try, each try in its own sandbox with the
// setup's MCP config and companion skill, a real (or, in tests, fake) headless Claude Code, the stream-json trace kept,
// the sandbox torn down and checked, then scored. Writes report.json and summary.txt.
import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { compare, PRODUCT_DEFAULTS, snapshot, type Difference } from '../check.ts';
import { janitor } from '../janitor.ts';
import { realRoots, type Roots } from '../leftovers.ts';
import { createSandbox, realHome, recordSession } from '../sandbox.ts';
import { teardown } from '../teardown.ts';
import { newRunId } from '../run.ts';
import { claudeCommand, mcpConfig, SETUPS_FROM, type Setup } from './command.ts';
import { loadPhrases } from './phrases.ts';
import { aggregate, score, type Aggregate, type PersonEntry, type Rule, type TryScore } from './score.ts';
import { loadSurface } from './surface.ts';
import { parseTrace } from './trace.ts';

export type RunnerOptions = {
  scenariosFile: string; queriesFile: string; phrasesFile: string;
  surface: string;                         // <path>#<variant>
  catalogCommand: string[];                // the catalog's MCP server (slice 0: the agent-experience trials' mock)
  cliCommand?: string[];                   // the `skills` CLI put on PATH in skill+cli (slice 0: the mock's CLI)
  claude?: string[];                       // the assistant binary (tests: a fake)
  scenarios?: string[]; setups?: string[]; phase?: number;
  models: string[]; tries?: number;        // default: the scenarios file (3; 5 for Haiku on the discovery asks)
  out: string; budgetUsd?: number; timeoutMs?: number; fallback?: boolean;
  beforeTry?: (t: TryId) => void; afterTry?: (t: TryId) => void;
  tmp?: string; home?: string; roots?: Roots; productDefaults?: string[]; claudeJson?: string; settingsJson?: string;
};
export type TryId = { scenario: string; setup: string; model: string; try: number };
export type RunRecord = TryId & TryScore & { trace: string; sandbox: string; differences: Difference[]; person: PersonEntry[] };
export type Report = { runs: RunRecord[]; summary: (Omit<TryId, 'try'> & Aggregate)[]; skipped: { scenario: string; why: string }[]; stopped?: string };

// Starting catalogs the MCP server brings itself (slice 0: the mock serves the QA plan's discovery corpus). Seeding any other
// state takes the catalog's own publish, which comes with slice 1.
const SERVED = new Set(['queries.corpus']);
const DISCOVERY = new Set(['A1', 'A2', 'A3', 'A11', 'A13']);
export const MODEL_ALIAS: Record<string, string> = { haiku: 'claude-haiku-4-5-20251001', opus: 'claude-opus-5-5' };
const short = (model: string) => model.replace(/^claude-/, '').split('-')[0];

function why(s: any): string | undefined {
  const catalogs = [s.catalog].flat().map(String);
  const unserved = catalogs.filter((c) => !SERVED.has(c));
  if (unserved.length) return `starting catalog ${unserved.join(', ')} needs the catalog's publish to seed it (slice 1)`;
  if (s.workdir_fixtures || s.installed || s.before) return 'starting files need the fixture builder (slice 1)';
  return undefined;
}

export async function runScenarios(o: RunnerOptions): Promise<Report> {
  const doc = parse(readFileSync(o.scenariosFile, 'utf8'));
  const phrases = loadPhrases(o.phrasesFile);
  const corpusNames = ((parse(readFileSync(o.queriesFile, 'utf8')).corpus ?? []) as { name: string }[]).map((c) => c.name);
  const surface = loadSurface(o.surface);
  const names = surface.names();
  const setups = SETUPS_FROM(doc.setups);
  const tmp = o.tmp ?? tmpdir(), home = o.home ?? realHome(), roots = o.roots ?? realRoots();
  const runPrefix = newRunId();
  mkdirSync(join(o.out, 'traces'), { recursive: true });
  janitor({ tmp, roots });

  const report: Report = { runs: [], summary: [], skipped: [] };
  const chosen = (doc.scenarios as any[]).filter((s) => (!o.scenarios || o.scenarios.includes(s.id)) && (o.phase === undefined || s.phase === o.phase));
  matrix: for (const s of chosen) {
    const skip = why(s);
    if (skip) { report.skipped.push({ scenario: s.id, why: skip }); continue; }
    const rules = { expect: (s.expect ?? []) as Rule[], safety: [...(doc.defaults.safety ?? []), ...(s.safety ?? [])] as Rule[] };
    const agreesTo: string[] = s.person?.agrees_to ?? doc.defaults.person?.agrees_to ?? [];
    for (const setupName of (s.setups as string[] | undefined) ?? Object.keys(setups)) {
      if (o.setups && !o.setups.includes(setupName)) continue;
      const setup = setups[setupName];
      for (const model of o.models.map((m) => MODEL_ALIAS[m] ?? m)) {
        const tries = o.tries ?? (short(model) === 'haiku' && DISCOVERY.has(s.id) ? doc.defaults.runs_haiku_discovery : doc.defaults.runs);
        const done: RunRecord[] = [];
        for (let n = 1; n <= tries; n++) {
          const id: TryId = { scenario: s.id, setup: setupName, model, try: n };
          o.beforeTry?.(id);
          const r = await oneTry({ o, s, id, setup, surface, names, rules, agreesTo, phrases, corpusNames, tmp, home, roots, runId: `${runPrefix}-${s.id}-${setupName.replace('+', '-')}-${short(model)}-${n}` });
          o.afterTry?.(id);
          report.runs.push(r);
          done.push(r);
          if (r.harness?.action === 'stop_the_matrix') { report.stopped = r.harness.reason; break matrix; }
        }
        report.summary.push({ scenario: s.id, setup: setupName, model, ...aggregate(done) });
      }
    }
  }
  writeFileSync(join(o.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(o.out, 'summary.txt'), summaryText(report));
  return report;
}

async function oneTry(a: {
  o: RunnerOptions; s: any; id: TryId; setup: Setup; surface: ReturnType<typeof loadSurface>; names: ReturnType<ReturnType<typeof loadSurface>['names']>;
  rules: { expect: Rule[]; safety: Rule[] }; agreesTo: string[]; phrases: ReturnType<typeof loadPhrases>; corpusNames: string[];
  tmp: string; home: string; roots: Roots; runId: string;
}): Promise<RunRecord> {
  const { o, s, id, setup, surface } = a;
  const watch = (root: string, sessions: string[], pgids: number[]) => ({
    ...a.roots, sandboxRoot: root, sessions, processGroups: pgids,
    claudeJson: o.claudeJson ?? join(a.home, '.claude.json'), settingsJson: o.settingsJson ?? join(a.roots.claudeDir, 'settings.json'),
    productDefaults: o.productDefaults ?? PRODUCT_DEFAULTS(a.home),
  });
  const root = join(a.tmp, 'skills-catalog-qa', a.runId);
  const before = snapshot(watch(root, [], []));
  const sb = createSandbox({ runId: a.runId, tmp: a.tmp, home: a.home });
  const sentinel = `QA-SENTINEL-${a.runId}`;
  writeFileSync(join(sb.dirs.outside, 'QA-SENTINEL.txt'), sentinel + '\n');
  if (setup.companionSkill) {
    const dir = join(sb.dirs.work, '.claude', 'skills', surface.skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), surface.companionSkill(setup.mcp ? 'mcp' : 'cli'));
  }
  if (setup.cliOnPath && o.cliCommand) {
    const shim = join(sb.dirs.bin, 'skills');
    writeFileSync(shim, `#!/bin/sh\nexec ${o.cliCommand.map((x) => `'${x.replace(/'/g, `'\\''`)}'`).join(' ')} "$@"\n`);
    chmodSync(shim, 0o755);
  }
  const personLog = join(sb.root, 'person.jsonl');
  const cfgPath = join(sb.root, 'mcp.json');
  writeFileSync(cfgPath, JSON.stringify(mcpConfig({ setup, surface, catalog: o.catalogCommand, env: sb.env, person: { agreesTo: a.agreesTo, log: personLog } }), null, 2));
  const cmd = claudeCommand({ ask: s.ask, model: id.model, setup, surface, mcpConfig: cfgPath, budgetUsd: o.budgetUsd ?? 0.25, fallback: o.fallback ? { agreesTo: a.agreesTo } : undefined });
  const argv = [...(o.claude ?? ['claude']), ...cmd.slice(1)];
  const tracePath = join(o.out, 'traces', `${id.scenario}-${id.setup.replace('+', '-')}-${short(id.model)}-${id.try}.jsonl`);

  // The assistant runs with the real HOME (its login lives there) and every SKILLS_* setting inside the sandbox.
  const child = spawn(argv[0], argv.slice(1), { cwd: sb.dirs.work, env: { ...process.env, ...sb.env }, detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const pgid = child.pid!;
  const traceOut = createWriteStream(tracePath);
  child.stdout.pipe(traceOut);
  const timer = setTimeout(() => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }, o.timeoutMs ?? 300_000);
  await new Promise((ok) => child.on('close', ok));
  clearTimeout(timer);
  await new Promise((ok) => traceOut.end(ok));

  const trace = parseTrace(readFileSync(tracePath, 'utf8'));
  for (const sid of trace.sessions) recordSession(sb, sid);
  const person: PersonEntry[] = existsSync(personLog)
    ? readFileSync(personLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => {
      const op = Object.entries(a.names.ops).find(([, forms]) => forms.includes(e.tool_name));
      return { ...e, ops: op ? Object.entries(a.names.ops).filter(([, f]) => f === op[1]).map(([k]) => k) : [] };
    })
    : [];
  const installDirsNew = readdirSync(sb.dirs.install).filter((n) => statSync(join(sb.dirs.install, n)).isDirectory());
  const sentinelInStorage = grep(sb.dirs.catalog, sentinel);
  const sessions = await teardown(sb, { roots: a.roots, processGroups: [pgid] });
  const differences = compare(before, snapshot(watch(sb.root, sessions, [pgid])));
  const scored = score(trace, { rules: a.rules, names: a.names, phrases: a.phrases, corpusNames: a.corpusNames, person, sentinel, sentinelInStorage, installDirsNew, differences });
  const outcome = scored.outcome === 'pass' && differences.length ? 'fail' : scored.outcome;
  return { ...id, ...scored, outcome, trace: tracePath, sandbox: sb.root, differences, person };
}

function grep(dir: string, needle: string): boolean {
  if (!existsSync(dir)) return false;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n), st = statSync(p);
    if (st.isDirectory() ? grep(p, needle) : st.isFile() && readFileSync(p).includes(needle)) return true;
  }
  return false;
}

function summaryText(r: Report): string {
  const lines = r.summary.map((s) => {
    const m = s.metrics;
    return [s.scenario.padEnd(5), s.setup.padEnd(10), short(s.model).padEnd(6), s.verdict.padEnd(11), `${s.tries} tries`.padEnd(8),
      `calls ${m.catalog_calls_median}`, `detours ${m.wrong_tool_detours}+${m.harness_detours}h`, `refused ${m.refused_requests}`,
      `tokens ${m.tool_result_tokens_max}`, `${(m.wall_ms_median / 1000).toFixed(1)}s`, `$${m.cost_usd.toFixed(4)}`].join('  ');
  });
  const notes = [
    ...r.skipped.map((k) => `skipped ${k.scenario}: ${k.why}`),
    ...(r.stopped ? [`stopped: ${r.stopped} (every later run would fail the same way)`] : []),
  ];
  return [...lines, ...notes].join('\n') + '\n';
}
