#!/usr/bin/env node
// qa: the skills catalog's QA tools (the QA plan §11). The command line is the one place that picks the real machine; with
// --fake-machine <dir> every place qa reads, writes or deletes is under <dir> (how the tests run it).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { preflight } from './agent/preflight.ts';
import { runScenarios } from './agent/runner.ts';
import { ruleCheck } from './agent/score.ts';
import { scrubTrace } from './agent/scrub.ts';
import { janitor } from './janitor.ts';
import type { Cleanup } from './leftovers.ts';
import { fakeMachine, realMachine, type Machine } from './machine.ts';
import { UnsafeError } from './safe-delete.ts';
import { traceCheck } from './trace-check.ts';
import { newRunId, qaRun } from './run.ts';
import { FailSafeError } from './sandbox.ts';

const USAGE = `qa: the skills catalog's QA tools

  qa run [--timeout <seconds>] [--ttl <seconds>] -- <command> [args…]
      Runs the command in a fresh sandbox ($TMPDIR/skills-catalog-qa/<run-id>/) with SKILLS_* pointing into it, in its own
      process group; tears everything down on pass, fail, timeout (default 30 minutes) or Ctrl-C; then checks that nothing
      outside the sandbox changed, processes and ports included. Exit: the command's code, 2 if something was left behind,
      3 if a safety check refused to start, 124 on timeout, 130 on Ctrl-C.
  qa janitor [--ttl <seconds>] [--dry-run]
      Removes finished runs older than the TTL (default 1 hour) and their exact leftovers; reports what it won't delete.
      --dry-run lists what it would remove and removes nothing.
  qa agent --surface <surface.yaml>#<variant> --mcp "<catalog MCP server command>" [--cli "<catalog CLI command>"] [--claude "<command>"]
           [--scenario A1,A2] [--setup mcp,mcp+skill,skill+cli] [--models haiku,opus] [--tries <n>] [--out <dir>]
           [--budget <usd>] [--fallback] [--no-preflight]
      The agent scenario runner: a real headless Claude Code per scenario × setup × model × try, each in its own
      sandbox, scored from its trace (golden/agent-scenarios.yaml). A pre-flight runs first (unit tests, every variant
      renders, the server's self-test, a login probe) and nothing runs unless it's clean. Spends money on your Claude login: each run is
      capped with --max-budget-usd. Writes <out>/report.json, <out>/summary.txt and every trace. Exit: 0 all pass, 1 a
      failure or nothing ran, 3 stopped (pre-flight, harness error), 130 on Ctrl-C.
  qa trace-check [--backlog <dir>]
      Every requirement has an automated check; every golden, catalog, query, fixture and backlog reference resolves;
      every requirement item (default: ../requirements, the exported list) maps to one, with a matching phase; the query
      sets match the queries; the hand-written diffs equal diff -u; the fingerprints and name lengths hold.
  qa scrub-trace <trace.jsonl> [--sandbox <root>]
      Prints the trace with the home folder, the sandbox path and session ids replaced, before it becomes a test fixture.

  Every command that touches a machine also takes --fake-machine <dir> (tests: tmp, home and Claude's folders under <dir>).`;

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
      for (const s of [...r.janitor.skipped, ...r.teardown.skipped]) if (!/^live run/.test(s.why)) console.error(`  not deleted: ${s.path}: ${s.why}`);
      for (const d of r.differences) console.error(`  left behind: ${d.what}`);
      for (const pid of r.stopped) console.error(`  stopped process ${pid}, which the run left running`);
      console.error(`qa run ${r.runId}: ${r.status}${r.differences.length ? '' : ', nothing left behind'}`);
      return { pass: 0, fail: r.exitCode || 1, leak: 2, timeout: 124, interrupted: 130 }[r.status];
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
        const problems = await preflight({ qaDir: new URL('..', import.meta.url).pathname, scenariosFile: golden('agent-scenarios.yaml'), surfaceFile, variant, catalogCommand: words(a.mcp)!, claude: words(a.claude), machine, scenarios: list(a.scenario) });
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
    default:
      return console.error(USAGE), 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  const refused = e instanceof FailSafeError || e instanceof UnsafeError;
  console.error(refused ? `qa: ${e.message}` : e);
  process.exit(refused ? 3 : 1);
});
