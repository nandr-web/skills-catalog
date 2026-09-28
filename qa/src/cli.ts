#!/usr/bin/env node
// qa: the skills catalog's QA tools (qa-plan §11).
//   qa run [--timeout <s>] [--ttl <s>] -- <command> [args…]    run a command in a clean, checked sandbox
//   qa janitor [--ttl <s>]                                     remove old runs and their leftovers
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runScenarios } from './agent/runner.ts';
import { janitor } from './janitor.ts';
import { traceCheck } from './trace-check.ts';
import { newRunId, qaRun } from './run.ts';
import { FailSafeError } from './sandbox.ts';

const USAGE = `qa: the skills catalog's QA tools

  qa run [--timeout <seconds>] [--ttl <seconds>] -- <command> [args…]
      Runs the command in a fresh sandbox ($TMPDIR/skills-catalog-qa/<run-id>/) with SKILLS_* pointing into it, in its own
      process group; tears everything down on pass, fail, timeout or Ctrl-C; then checks that nothing outside the sandbox
      changed. Exit: the command's code, 2 if something was left behind, 124 on timeout, 130 on Ctrl-C.
  qa janitor [--ttl <seconds>]
      Removes runs older than the TTL (default 1 hour) and their leftovers.
  qa agent --surface <surface.yaml>#<variant> --mcp "<catalog MCP server command>" [--cli "<skills CLI command>"]
           [--scenario A1,A2] [--setup mcp,mcp+skill,skill+cli] [--models haiku,opus] [--tries <n>] [--out <dir>]
           [--budget <usd>] [--fallback]
      The agent scenario runner: a real headless Claude Code per scenario × setup × model × try, each in its own
      sandbox, scored from its trace (golden/agent-scenarios.yaml). Spends money on your Claude login: each run is
      capped with --max-budget-usd. Writes <out>/report.json, <out>/summary.txt and every trace.
  qa trace-check [--backlog <dir>]
      Every requirement has an automated check; every golden, catalog, query, fixture and backlog reference resolves;
      every requirement item (default: ../requirements, the exported list) maps to one, with a matching phase; the query
      sets match the queries; the hand-written diffs equal diff -u; the fingerprints and name lengths hold.`;

async function main(argv: string[]): Promise<number> {
  const dash = argv.indexOf('--');
  const own = dash < 0 ? argv : argv.slice(0, dash), command = dash < 0 ? [] : argv.slice(dash + 1);
  const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options: { timeout: { type: 'string' }, ttl: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  const seconds = (v?: string) => (v === undefined ? undefined : Number(v) * 1000);
  if (values.help) return console.log(USAGE), 0;
  switch (positionals[0]) {
    case 'run': {
      if (!command.length) return console.error(USAGE), 1;
      const stop = new AbortController();
      process.on('SIGINT', () => stop.abort());
      process.on('SIGTERM', () => stop.abort());
      const r = await qaRun({
        command, timeoutMs: seconds(values.timeout), ttlMs: seconds(values.ttl), signal: stop.signal, stdio: 'inherit',
        onStart: (sb) => console.error(`qa run ${sb.runId}: sandbox ${sb.root}`),
      });
      for (const d of r.differences) console.error(`  left behind: ${d.what}`);
      console.error(`qa run ${r.runId}: ${r.status}${r.differences.length ? '' : ', nothing left behind'}`);
      return { pass: 0, fail: r.exitCode || 1, leak: 2, timeout: 124, interrupted: 130 }[r.status];
    }
    case 'janitor':
      for (const p of janitor({ ttlMs: seconds(values.ttl) })) console.error(`removed ${p}`);
      return 0;
    case 'trace-check': {
      const b = parseArgs({ args: own.slice(1), options: { backlog: { type: 'string' } } }).values;
      const r = traceCheck({ qa: new URL('..', import.meta.url).pathname, backlog: b.backlog });
      console.log(`${r.counts.backlog} requirement items, ${r.counts.requirements} requirements, ${r.counts.scenarios} scenarios, ${r.counts.queries} queries, ${r.counts.policy} policy cases`);
      console.log(r.problems.length ? r.problems.join('\n') : 'trace-check: no issues');
      return r.problems.length ? 1 : 0;
    }
    case 'agent': {
      const a = parseArgs({ args: own.slice(1), options: {
        surface: { type: 'string' }, mcp: { type: 'string' }, cli: { type: 'string' }, scenario: { type: 'string' }, setup: { type: 'string' },
        models: { type: 'string', default: 'haiku' }, tries: { type: 'string' }, out: { type: 'string' }, budget: { type: 'string' }, fallback: { type: 'boolean' },
      } }).values;
      if (!a.surface || !a.mcp) return console.error(USAGE), 1;
      const list = (v?: string) => v?.split(',').map((x) => x.trim()).filter(Boolean);
      const words = (v?: string) => v?.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((w) => w.replace(/^["']|["']$/g, ''));
      const golden = (f: string) => new URL(`../golden/${f}`, import.meta.url).pathname;
      const out = a.out ?? `out/agent/${newRunId()}`;
      const report = await runScenarios({
        scenariosFile: golden('agent-scenarios.yaml'), queriesFile: golden('queries.yaml'), phrasesFile: golden('phrases.yaml'),
        surface: a.surface, catalogCommand: words(a.mcp)!, cliCommand: words(a.cli), scenarios: list(a.scenario), setups: list(a.setup),
        models: list(a.models)!, tries: a.tries ? Number(a.tries) : undefined, out, budgetUsd: a.budget ? Number(a.budget) : undefined, fallback: a.fallback,
      });
      process.stdout.write(readFileSync(`${out}/summary.txt`, 'utf8'));
      console.error(`qa agent: report ${out}/report.json`);
      return report.stopped ? 3 : report.summary.every((s) => s.verdict === 'pass') ? 0 : 1;
    }
    default:
      return console.error(USAGE), 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e instanceof FailSafeError ? e.message : e);
  process.exit(e instanceof FailSafeError ? 3 : 1);
});
