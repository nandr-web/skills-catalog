#!/usr/bin/env node
// qa: the skills catalog's QA tools (the QA plan §11). The command line is the one place that picks the real machine; with
// --fake-machine <dir> every place qa reads, writes or deletes is under <dir> (how the tests run it).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { fileURLToPath } from 'node:url';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { preflight } from './agent/preflight.ts';
import { runScenarios } from './agent/runner.ts';
import { ruleCheck } from './agent/score.ts';
import { scrubTrace } from './agent/scrub.ts';
import type { StepView } from './demo/conductor.ts';
import type { Scenes } from './demo/scenes.ts';
import { janitor } from './janitor.ts';
import type { Cleanup } from './leftovers.ts';
import { fakeMachine, realMachine, type Machine } from './machine.ts';
import { UnsafeError } from './safe-delete.ts';
import { CheckBlind } from './check.ts';
import { traceCheck } from './trace-check.ts';
import { newRunId, qaRun, type RunResult } from './run.ts';
import { childEnv, FailSafeError } from './sandbox.ts';

const USAGE = `qa: the skills catalog's QA tools

  qa run [--timeout <seconds>] [--ttl <seconds>] -- <command> [args…]
      Runs the command in a fresh sandbox ($TMPDIR/skills-catalog-qa/<run-id>/) with SKILLS_* pointing into it, in its own
      process group; tears everything down on pass, fail, timeout (default 30 minutes) or Ctrl-C; then checks that nothing
      outside the sandbox changed, processes and ports included. Exit: the command's code, 2 if something was left behind,
      3 if a safety check refused to start, 124 on timeout, 130 on Ctrl-C.
  qa janitor [--ttl <seconds>] [--dry-run]
      Removes finished runs older than the TTL (default 1 hour) and their exact leftovers; reports what it won't delete.
      --dry-run lists what it would remove and removes nothing.
  qa agent --surface <surface.yaml>#<variant> --mcp "<catalog MCP server command>" [--cli "<catalog CLI command>"] [--claude <full path>]
           [--scenario A1,A2] [--setup mcp,mcp+skill,skill+cli] [--models haiku,opus] [--tries <n>] [--out <dir>]
           [--budget <usd>] [--fallback] [--no-preflight]
      The agent scenario runner: a real headless Claude Code per scenario × setup × model × try, each in its own
      sandbox, scored from its trace (golden/agent-scenarios.yaml). Claude Code is started only by its full path
      (default ~/.local/bin/claude), never a name looked up on PATH, and never a copy macOS hasn't approved. A pre-flight
      runs first (the assistant's path and version, unit tests, every variant renders, the server's self-test, a login
      probe) and nothing runs unless it's clean. Spends money on your Claude login: each run is
      capped with --max-budget-usd. Writes <out>/report.json, <out>/summary.txt and every trace. Exit: 0 all pass, 1 a
      failure or nothing ran, 3 stopped (pre-flight, harness error), 130 on Ctrl-C.
  qa trace-check [--backlog <dir>]
      Every requirement has an automated check; every golden, catalog, query, fixture and backlog reference resolves;
      every requirement item (default: ../requirements, the exported list) maps to one, with a matching phase; the query
      sets match the queries; the hand-written diffs equal diff -u; the fingerprints and name lengths hold.
  qa scrub-trace <trace.jsonl> [--sandbox <root>]
      Prints the trace with the home folder, the sandbox path and session ids replaced, before it becomes a test fixture.
  qa demo [--step] [--only 5,6] [--pace <seconds>] [--close-after <seconds>] [--headless] [--size <columns>x<rows>] [--out <dir>] [--server "<command>" | --core] [--live]
      The one-click demo (npm run demo): one tmux window, split in four (two developers' assistants, the steps with what
      to look for, the catalog's log), plays the steps in demo/scenes.yaml, typing each into a developer's pane, and
      checks that what should show does. Its own tmux server, inside a qa run's sandbox: your tmux, home and settings are
      never touched, and everything is removed at the end. Enter: the next step now; p: pause; q or Ctrl-C: stop.
      --step waits for Enter before each step; --only runs only those steps (the ones before them first, at once); --pace
      waits that long after each step (default 3); --close-after closes the window by itself that long after the last
      step, instead of waiting for q; --headless opens no window and saves each pane's text to --out
      (default out/demo/<run-id>/); --server: the stand-ins call the catalog's MCP server, one per developer, started with
      this command (its words split at spaces, or a JSON array of them; no shell; the first an absolute path) and the
      sandbox's settings only; by default this repository's own (../client, once npm ci has run there); --core: they call
      the core in their own process instead (the default while ../client isn't installed); --live (real assistants) isn't
      built yet. An attached run has no time limit; a headless one, qa run's 30 minutes. Exit: 0 every step seen or
      planned, 1 a step missed, a flag refused or the director failed, 2 something was left behind, 3 a pre-flight check
      refused to start, 124 timed out (headless only), 130 stopped (q or Ctrl-C before the last step).
      Tests point it at other files, with --fake-machine only: DEMO_SCENES, DEMO_ASSISTANT, DEMO_STEPS_VIEW, DEMO_CORE, DEMO_CLIENT.

  Every command that touches a machine also takes --fake-machine <dir> (tests: tmp, home and Claude's folders under <dir>).`;

/** A run's last line: its status, and that nothing was left behind when that's so. */
function statusLine(name: string, r: RunResult): string {
  const nothing = process.platform === 'darwin' ? ', nothing left behind' : '; files, settings and ports unchanged; processes not checked on this system yet';
  return `qa ${name} ${r.runId}: ${r.status}${r.differences.length ? '' : nothing}`;
}

/** A run's ending, as `qa run` says it; returns its exit code. */
function reportRun(name: string, r: RunResult): number {
  for (const s of [...r.janitor.skipped, ...r.teardown.skipped]) if (!/^live run/.test(s.why)) console.error(`  not deleted: ${s.path}: ${s.why}`);
  for (const d of r.differences) console.error(`  left behind: ${d.what}`);
  for (const pid of r.stopped) console.error(`  stopped process ${pid}, which the run left running`);
  console.error(statusLine(name, r));
  return { pass: 0, fail: r.exitCode || 1, leak: 2, timeout: 124, interrupted: 130 }[r.status];
}

function report(c: Cleanup, verb: string): void {
  for (const p of c.removed) console.log(`${verb} ${p}`);
  for (const s of c.skipped) if (!/^live run/.test(s.why)) console.error(`  not deleted: ${s.path}: ${s.why}`);
}

async function main(argv: string[]): Promise<number> {
  // Each command parses its own flags: the first word picks the command, `--` ends qa's flags (qa run -- <command>).
  const dash = argv.indexOf('--');
  const own = dash < 0 ? argv : argv.slice(0, dash), command = dash < 0 ? [] : argv.slice(dash + 1);
  const [name, ...flags] = own;
  const seconds = (v?: string) => (v === undefined ? undefined : Number(v) * 1000);
  if (!name || name === '-h' || name === '--help' || flags.includes('--help') || flags.includes('-h')) return console.log(USAGE), name ? 0 : 1;
  const opts = (options: ParseArgsOptionsConfig) => parseArgs({ args: flags, options: { ...options, 'fake-machine': { type: 'string' } } }).values as Record<string, any>;
  const machineOf = (v: Record<string, any>): Machine => (v['fake-machine'] ? fakeMachine(v['fake-machine']) : realMachine());
  switch (name) {
    case 'run': {
      const values = opts({ timeout: { type: 'string' }, ttl: { type: 'string' } });
      if (!command.length) return console.error(USAGE), 1;
      const machine = machineOf(values);
      const stop = new AbortController();
      process.on('SIGINT', () => stop.abort());
      process.on('SIGTERM', () => stop.abort());
      const r = await qaRun({
        machine, command, timeoutMs: seconds(values.timeout), ttlMs: seconds(values.ttl), signal: stop.signal, stdio: 'inherit',
        onStart: (sb) => console.error(`qa run ${sb.runId}: sandbox ${sb.root}`),
      });
      return reportRun('run', r);
    }
    case 'janitor': {
      const values = opts({ ttl: { type: 'string' }, 'dry-run': { type: 'boolean' } });
      const dryRun = !!values['dry-run'];
      report(janitor({ machine: machineOf(values), ttlMs: seconds(values.ttl), dryRun }), dryRun ? 'would remove' : 'removed');
      return 0;
    }
    case 'trace-check': {
      const b = opts({ backlog: { type: 'string' } });
      const r = traceCheck({ qa: new URL('..', import.meta.url).pathname, backlog: b.backlog });
      console.log(`${r.counts.backlog} requirement items, ${r.counts.requirements} requirements, ${r.counts.scenarios} scenarios, ${r.counts.queries} queries, ${r.counts.policy} policy cases`);
      console.log(r.problems.length ? r.problems.join('\n') : 'trace-check: no issues');
      return r.problems.length ? 1 : 0;
    }
    case 'scrub-trace': {
      const p = parseArgs({ args: flags, options: { sandbox: { type: 'string' } }, allowPositionals: true });
      if (p.positionals.length !== 1) return console.error(USAGE), 1;
      process.stdout.write(scrubTrace(readFileSync(p.positionals[0], 'utf8'), { sandboxRoot: p.values.sandbox }));
      return 0;
    }
    case 'agent': {
      const a = opts({
        surface: { type: 'string' }, mcp: { type: 'string' }, cli: { type: 'string' }, claude: { type: 'string' }, scenario: { type: 'string' }, setup: { type: 'string' },
        models: { type: 'string', default: 'haiku' }, tries: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' }, fallback: { type: 'boolean' },
        'no-preflight': { type: 'boolean' },
      });
      if (!a.surface || !a.mcp) return console.error(USAGE), 1;
      const machine = machineOf(a);
      const list = (v?: string) => v?.split(',').map((x) => x.trim()).filter(Boolean);
      const words = (v?: string) => v?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => w.replace(/^["']|["']$/g, ''));
      const golden = (f: string) => new URL(`../golden/${f}`, import.meta.url).pathname;
      const out = a.out ?? `out/agent/${newRunId()}`;
      if (!a['no-preflight']) {
        const [surfaceFile, variant] = a.surface.split('#');
        const problems = await preflight({ qaDir: new URL('..', import.meta.url).pathname, scenariosFile: golden('agent-scenarios.yaml'), surfaceFile, variant, catalogCommand: words(a.mcp)!, claude: words(a.claude), machine, scenarios: list(a.scenario), report: (l) => console.error(`qa agent: ${l}`) });
        if (problems.length) { console.error(`qa agent: pre-flight failed, nothing ran:\n  ${problems.join('\n  ')}`); return 3; }
        console.error('qa agent: pre-flight clean');
        const later = ruleCheck(parse(readFileSync(golden('agent-scenarios.yaml'), 'utf8')), list(a.scenario)).incomplete;
        if (later.length) console.error(`qa agent: these will be incomplete (their rules wait on a later slice):\n  ${later.join('\n  ')}`);
      }
      const stop = new AbortController();
      process.on('SIGINT', () => stop.abort());
      process.on('SIGTERM', () => stop.abort());
      let report;
      try {
        report = await runScenarios({
          scenariosFile: golden('agent-scenarios.yaml'), queriesFile: golden('queries.yaml'), phrasesFile: golden('phrases.yaml'),
          surface: a.surface, catalogCommand: words(a.mcp)!, cliCommand: words(a.cli), claude: words(a.claude), scenarios: list(a.scenario), setups: list(a.setup),
          models: list(a.models)!, tries: a.tries ? Number(a.tries) : undefined, out, budgetUsd: a.budget ? Number(a.budget) : undefined, fallback: a.fallback,
          signal: stop.signal, machine,
        });
      } catch (e) {
        if (e instanceof UnsafeError || e instanceof FailSafeError) throw e;
        console.error(`qa agent: ${(e as Error).message}`);
        return 1;
      }
      process.stdout.write(readFileSync(`${out}/summary.txt`, 'utf8'));
      console.error(`qa agent: report ${out}/report.json`);
      if (report.stopped === 'interrupted') { console.error('qa agent: interrupted; the try was torn down'); return 130; }
      if (report.stopped) return 3;
      if (!report.runs.length) { console.error('qa agent: nothing ran (every chosen scenario was skipped); see the summary'); return 1; }
      return report.summary.every((s) => s.verdict === 'pass') ? 0 : 1;
    }
    case 'demo': {
      // the demo's modules load for this command only: every other command starts without them
      const [{ doneLine, stoppedLine }, { loadScenes }, { DIRECTOR, demoEnding, demoPaths, demoTimeoutMs, parseSize, preflight: demoPreflight, repoServer, serverCommand, showWindow }, { findTmux, tmuxVersion, useTmux }] =
        await Promise.all([import('./demo/conductor.ts'), import('./demo/scenes.ts'), import('./demo/director.ts'), import('./demo/tmux.ts')]);
      const d = opts({
        step: { type: 'boolean' }, only: { type: 'string' }, pace: { type: 'string', default: '3' }, 'close-after': { type: 'string' }, headless: { type: 'boolean' }, size: { type: 'string' },
        out: { type: 'string' }, server: { type: 'string' }, core: { type: 'boolean' }, live: { type: 'boolean' },
      });
      const headless = !!d.headless;
      const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
      const tmuxBin = findTmux();
      const paths = demoPaths(process.env, !!d['fake-machine']);
      const refused = demoPreflight({ node: process.versions.node, tmux: tmuxVersion(tmuxBin), coreDir: paths.core, tty, headless, live: !!d.live });
      if (refused.length) { for (const p of refused) console.error(`qa demo: ${p}`); return 3; }
      // attached, the window starts at this terminal's size (80x24 when it says none, as tmux then assumes), so the
      // layout isn't squeezed when the window attaches
      const size: string = d.size ?? (headless ? '200x50' : `${Math.max(process.stdout.columns || 80, 80)}x${Math.max(process.stdout.rows || 24, 24)}`);
      const scenesFile = paths.scenes;
      const only = d.only?.split(',').map((x: string) => x.trim()).filter(Boolean) as string[] | undefined;
      const bad: string[] = [];
      if (!/^\d+(\.\d+)?$/.test(d.pace)) bad.push(`--pace ${d.pace}: a number of seconds`);
      if (d['close-after'] !== undefined && !/^\d+(\.\d+)?$/.test(d['close-after'])) bad.push(`--close-after ${d['close-after']}: a number of seconds`);
      if (!parseSize(size)) bad.push(`--size ${size}: <columns>x<rows>, at least 80x24`);
      let scenes: Scenes | undefined;
      try { scenes = loadScenes(scenesFile); } catch (e) { bad.push((e as Error).message); }
      for (const id of only ?? []) if (scenes && !scenes.steps.some((s) => String(s.id) === id)) bad.push(`--only: no step ${id} in ${scenesFile}`);
      const runId = newRunId();
      const out = resolve(d.out ?? fileURLToPath(new URL(`../out/demo/${runId}`, import.meta.url)));
      // the run writes only new files there, never over one of yours
      if (existsSync(out) && readdirSync(out).length) bad.push(`--out ${out}: not empty; choose a new folder, or leave --out off`);
      // The catalog the stand-ins call: the MCP server --server names, else this repository's own once it's installed;
      // --core (or no installed server): the core, in each stand-in's own process.
      if (d.core && d.server !== undefined) bad.push('--core and --server: choose one');
      const own = repoServer(paths.client);
      const server: string | undefined = d.core ? undefined : d.server ?? own;
      if (server !== undefined) {
        try {
          const [program] = serverCommand(server);
          if (!existsSync(program!)) bad.push(`--server: ${program} isn't there`);
        } catch (e) { bad.push(`--server: ${(e as Error).message}`); }
      }
      if (bad.length) { for (const b of bad) console.error(`qa demo: ${b}`); return 1; }
      const catalog = server === undefined
        ? `the core in their own process${d.core ? '' : " (../client isn't installed: npm ci --ignore-scripts there to use its MCP server)"}`
        : server === own ? "this repository's MCP server (../client)" : 'the MCP server given with --server';

      useTmux(tmuxBin!);   // by path from here on: the run's PATH (the system's folders) may not have it
      const machine = machineOf(d);
      mkdirSync(out, { recursive: true });
      const stop = new AbortController();
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => stop.abort());
      let window: Promise<void> | undefined, running = true;
      const r = await qaRun({
        machine, runId, signal: stop.signal, stdio: 'ignore', timeoutMs: demoTimeoutMs(headless),
        command: [
          process.execPath, DIRECTOR, '--tmux', tmuxBin!, '--scenes', scenesFile, '--assistant', paths.assistant,
          '--steps-view', paths.stepsView, '--out', out, '--pace', d.pace, '--size', size, ...(d['close-after'] !== undefined ? ['--close-after', d['close-after']] : []),
          ...(d.step ? ['--step'] : []), ...(only ? ['--only', only.join(',')] : []), ...(headless ? ['--headless'] : []),
          ...(server !== undefined ? [`--server=${server}`] : []),
        ],
        onStart: (sb) => {
          console.error(`qa demo ${sb.runId}: sandbox ${sb.root}`);
          console.error(`qa demo: the stand-ins call ${catalog}`);
          // the client is the qa process's own, not the run's: without the run's id
          const env = Object.fromEntries(Object.entries(childEnv(sb)).filter(([k]) => k !== 'QA_RUN_ID'));
          if (!headless) window = showWindow(sb.root, env, () => stop.abort(), () => running);
        },
      });
      running = false;
      await window;
      const error = existsSync(join(out, 'error.txt')), summary = existsSync(join(out, 'summary.json'));
      if (error) console.error(`qa demo: the director stopped: ${readFileSync(join(out, 'error.txt'), 'utf8').trim()}`);
      let stopped = false;
      if (summary) {
        const s = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
        for (const step of s.steps as StepView[]) if (step.state === 'missed') console.error(`  missed: step ${step.id}, ${step.title}: ${step.missing?.join('; ')}`);
        stopped = !!s.stopped;
        console.error(`qa demo: ${s.stopped ? stoppedLine(s.stopped) : doneLine(s.counts)}; each pane's text is in ${out}`);
      }
      // no summary: the director failed, never a pass; q or Ctrl-C before the last step: interrupted (130)
      const { ended, note } = demoEnding(r, { summary, stopped, error });
      if (note) console.error(`qa demo: ${note}`);
      writeFileSync(join(out, 'status.txt'), `${statusLine('demo', ended)}\n`, { flag: 'wx' });   // the ending, with the panes' text
      return reportRun('demo', ended);
    }
    default:
      return console.error(USAGE), 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  const refused = e instanceof FailSafeError || e instanceof UnsafeError || e instanceof CheckBlind;
  console.error(refused ? `qa: ${e.message}` : e);
  process.exit(refused ? 3 : 1);
});
