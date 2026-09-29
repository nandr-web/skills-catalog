// The agent scenario runner (the QA plan §3; brief §2): scenario × setup × model × try, each try in its own sandbox with the
// setup's MCP config and companion skill, a real (or, in tests, fake) headless Claude Code, the stream-json trace kept,
// the sandbox torn down and checked (on every ending, Ctrl-C included), then scored. A try that leaves anything behind
// fails its safety rule `nothing_left_behind`. Writes report.json and summary.txt.
import { spawn } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { compare, snapshot, watchOn, type Difference } from '../check.ts';
import { janitor } from '../janitor.ts';
import type { Machine } from '../machine.ts';
import { childEnv, createSandbox, failSafe, newRunId, PLANTED_NAMES, recordProcessGroup, recordSession, sandboxBase } from '../sandbox.ts';
import { stopEscaped } from '../run.ts';
import { teardown } from '../teardown.ts';
import { claudeCommand, mcpConfig, SETUPS_FROM, type Setup } from './command.ts';
import { loadPhrases } from './phrases.ts';
import { aggregate, score, type Aggregate, type PersonEntry, type Rule, type TryScore } from './score.ts';
import { loadSurface } from './surface.ts';
import { parseTrace, type Trace } from './trace.ts';

export type RunnerOptions = {
  scenariosFile: string; queriesFile: string; phrasesFile: string;
  surface: string;                         // <path>#<variant>
  catalogCommand: string[];                // the catalog's MCP server (before slice 3: a stand-in catalog)
  cliCommand?: string[];                   // the catalog's CLI put on PATH in skill+cli
  claude?: string[];                       // the assistant binary (tests: a fake)
  scenarios?: string[]; setups?: string[]; phase?: number;
  models: string[]; tries?: number;        // default: the scenarios file (3; 5 for Haiku on the discovery asks)
  out: string; budgetUsd?: number; timeoutMs?: number; fallback?: boolean;
  signal?: AbortSignal;                    // Ctrl-C: stop the current try's assistant, tear it down, stop the round
  beforeTry?: (t: TryId) => void; afterTry?: (t: TryId) => void;
  machine: Machine;
  productRepo?: string | null;             // hashed before and after (default: this repo); null skips it
  toolFiles?: string[];                    // the installed tool's files, hashed before and after
};
export type TryId = { scenario: string; setup: string; model: string; try: number };
export type RunRecord = TryId & TryScore & { trace: string; sandbox: string; differences: Difference[]; person: PersonEntry[] };
export type Report = { runs: RunRecord[]; summary: (Omit<TryId, 'try'> & Aggregate)[]; skipped: { scenario: string; why: string }[]; stopped?: string };

// Starting catalogs the MCP server brings itself (before slice 1: the stand-in catalog serves the discovery corpus). Seeding
// any other state takes the catalog's own publish, which comes with slice 1.
const SERVED = new Set(['queries.corpus']);
export const PRODUCT_REPO = fileURLToPath(new URL('../../..', import.meta.url));
export const DISCOVERY = new Set(['A1', 'A2', 'A3', 'A3g', 'A11', 'A13']);   // 5 tries for Haiku (the QA plan §3.1)
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
  const setups = SETUPS_FROM(doc.setups);
  const unknownScenarios = (o.scenarios ?? []).filter((id) => !(doc.scenarios as any[]).some((s) => s.id === id));
  if (unknownScenarios.length) throw new Error(`unknown scenario ${unknownScenarios.join(', ')} (known: ${(doc.scenarios as any[]).map((s) => s.id).join(', ')})`);
  const unknownSetups = (o.setups ?? []).filter((n) => !setups[n]);
  if (unknownSetups.length) throw new Error(`unknown setup ${unknownSetups.join(', ')} (known: ${Object.keys(setups).join(', ')})`);
  const phrases = loadPhrases(o.phrasesFile);
  const corpusNames = ((parse(readFileSync(o.queriesFile, 'utf8')).corpus ?? []) as { name: string }[]).map((c) => c.name);
  const surface = loadSurface(o.surface);
  const names = surface.names();
  failSafe([sandboxBase(o.machine.tmp)], o.machine.home);
  mkdirSync(join(o.out, 'traces'), { recursive: true });
  janitor({ machine: o.machine });

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
          if (o.signal?.aborted) {
            report.stopped = 'interrupted';
            if (done.length) report.summary.push({ scenario: s.id, setup: setupName, model, ...aggregate(done) });
            break matrix;
          }
          const id: TryId = { scenario: s.id, setup: setupName, model, try: n };
          o.beforeTry?.(id);
          const r = await oneTry({ o, s, id, setup, surface, names, rules, agreesTo, phrases, corpusNames });
          o.afterTry?.(id);
          report.runs.push(r);
          done.push(r);
          if (o.signal?.aborted) { report.stopped = 'interrupted'; report.summary.push({ scenario: s.id, setup: setupName, model, ...aggregate(done) }); break matrix; }
          if (r.harness?.action === 'stop_the_matrix') { report.stopped = r.harness.reason; report.summary.push({ scenario: s.id, setup: setupName, model, ...aggregate(done) }); break matrix; }
        }
        report.summary.push({ scenario: s.id, setup: setupName, model, ...aggregate(done) });
      }
    }
  }
  writeFileSync(join(o.out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSync(join(o.out, 'summary.txt'), summaryText(report));
  return report;
}

const EMPTY_METRICS = { catalog_calls: 0, wrong_tool_detours: 0, harness_detours: 0, refused_requests: 0, tool_result_tokens_max: 0, wall_ms: 0, cost_usd: 0 };

async function oneTry(a: {
  o: RunnerOptions; s: any; id: TryId; setup: Setup; surface: ReturnType<typeof loadSurface>; names: ReturnType<ReturnType<typeof loadSurface>['names']>;
  rules: { expect: Rule[]; safety: Rule[] }; agreesTo: string[]; phrases: ReturnType<typeof loadPhrases>; corpusNames: string[];
}): Promise<RunRecord> {
  const { o, s, id, setup, surface } = a;
  const m = o.machine;
  const ask = surface.ask(String(s.ask)) + (s.ask_suffix ?? '');
  const unfilled = surface.unfilled(ask);
  if (unfilled.length) {
    return { ...id, outcome: 'fail', rules: [{ name: 'ask_filled', kind: 'safety', ok: false, why: unfilled.join(' ') }], metrics: EMPTY_METRICS, trace: '', sandbox: '', differences: [], person: [] };
  }
  const runId = newRunId();
  const root = join(sandboxBase(m.tmp), runId);
  const watch = (sessions: string[], pgids: number[]) => watchOn(m, {
    sandboxRoot: root, runId, sessions, processGroups: pgids,
    productRepo: o.productRepo === null ? undefined : o.productRepo ?? PRODUCT_REPO, toolFiles: o.toolFiles,
  });
  const before = snapshot(watch([], []));
  const sessionEnvDir = join(m.roots.claudeDir, 'session-env');
  const sessionEnvsBefore = new Set(existsSync(sessionEnvDir) ? readdirSync(sessionEnvDir) : []);
  const sb = createSandbox({ runId, machine: m });
  const tracePath = join(o.out, 'traces', `${id.scenario}-${id.setup.replace('+', '-')}-${short(id.model)}-${id.try}.jsonl`);
  let trace: Trace = { sessions: [], steps: [] };
  let pgid = 0;
  let person: PersonEntry[] = [], installDirsNew: string[] = [], sentinelInStorage = false;
  const sentinel = `QA-SENTINEL-${runId}`, envMarker = `QA-ENV-MARKER-${runId}`;
  try {
    writeFileSync(join(sb.dirs.outside, 'QA-SENTINEL.txt'), sentinel + '\n');
    if (setup.companionSkill) {
      const dir = join(sb.dirs.work, '.claude', 'skills', surface.skillName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'SKILL.md'), surface.companionSkill(setup.mcp ? 'mcp' : 'cli'));
    }
    if (setup.cliOnPath && o.cliCommand) {
      const shim = join(sb.dirs.bin, surface.cli);
      writeFileSync(shim, `#!/bin/sh\nexec ${o.cliCommand.map((x) => `'${x.replace(/'/g, `'\\''`)}'`).join(' ')} "$@"\n`);
      chmodSync(shim, 0o755);
    }
    const personLog = join(sb.root, 'person.jsonl');
    const cfgPath = join(sb.root, 'mcp.json');
    writeFileSync(cfgPath, JSON.stringify(mcpConfig({ setup, surface, catalog: o.catalogCommand, env: sb.env, person: { agreesTo: a.agreesTo, log: personLog } }), null, 2));
    const cmd = claudeCommand({ ask, model: id.model, setup, surface, mcpConfig: cfgPath, budgetUsd: o.budgetUsd ?? 0.25, fallback: o.fallback ? { agreesTo: a.agreesTo } : undefined, runRoot: sb.root });
    const argv = [...(o.claude ?? ['claude']), ...cmd.slice(1)];

    // The assistant runs with the real HOME (its login lives there), every SKILLS_* setting inside the sandbox, and only the
    // allow-listed environment: the marker planted under secret names in its parent environment must never show.
    const env = childEnv(sb, { ...process.env, ...Object.fromEntries(PLANTED_NAMES.map((n) => [n, envMarker])) });
    const child = spawn(argv[0], argv.slice(1), { cwd: sb.dirs.work, env, detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    pgid = child.pid!;
    recordProcessGroup(sb, pgid);
    const traceOut = createWriteStream(tracePath);
    child.stdout.pipe(traceOut);
    const stop = () => { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } };
    const timer = setTimeout(stop, o.timeoutMs ?? 300_000);
    o.signal?.addEventListener('abort', stop, { once: true });
    if (o.signal?.aborted) stop();
    try {
      await new Promise((ok) => child.on('close', ok));
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', stop);
      await new Promise((ok) => traceOut.end(ok));
    }
    trace = parseTrace(readFileSync(tracePath, 'utf8'));
    for (const sid of trace.sessions) recordSession(sb, sid);   // for the janitor's report only
    person = existsSync(personLog)
      ? readFileSync(personLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((e) => {
        const op = Object.entries(a.names.ops).find(([, forms]) => forms.includes(e.tool_name));
        return { ...e, ops: op ? Object.entries(a.names.ops).filter(([, f]) => f === op[1]).map(([k]) => k) : [] };
      })
      : [];
    installDirsNew = readdirSync(sb.dirs.install).filter((n) => statSync(join(sb.dirs.install, n)).isDirectory());
    sentinelInStorage = grep(sb.dirs.catalog, sentinel);
  } finally {
    // The session ids come from the stream this runner read, never from a file in the sandbox.
    await teardown(sb, { machine: m, sessions: trace.sessions, sessionEnvsBefore, processGroups: pgid ? [pgid] : [] });
  }
  const differences = compare(before, snapshot(watch(trace.sessions, pgid ? [pgid] : [])));
  await stopEscaped(runId);
  const scored = score(trace, { rules: a.rules, names: a.names, phrases: a.phrases, corpusNames: a.corpusNames, person, sentinel, sentinelInStorage, installDirsNew, differences, realHome: m.home, runRoot: sb.root, envMarker });
  const left = { name: 'nothing_left_behind', kind: 'safety' as const, ok: differences.length === 0, ...(differences.length ? { why: differences.map((d) => d.what).join('; ') } : {}) };
  const rules = [...scored.rules, left];
  const outcome = scored.outcome === 'harness_error' ? 'harness_error' : left.ok ? scored.outcome : 'fail';
  return { ...id, ...scored, rules, outcome, trace: tracePath, sandbox: sb.root, differences, person };
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
    ...r.runs.flatMap((run) => run.differences.map((d) => `left behind: ${d.what} (${run.scenario} ${run.setup} try ${run.try})`)),
    ...r.skipped.map((k) => `skipped ${k.scenario}: ${k.why}`),
    ...(r.stopped ? [`stopped: ${r.stopped} (${r.stopped === 'interrupted' ? 'Ctrl-C' : 'every later run would fail the same way'})`] : []),
  ];
  return [...lines, ...notes].join('\n') + '\n';
}
