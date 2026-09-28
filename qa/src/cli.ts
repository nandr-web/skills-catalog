#!/usr/bin/env node
// qa: the skills catalog's QA tools (qa-plan §11).
//   qa run [--timeout <s>] [--ttl <s>] -- <command> [args…]    run a command in a clean, checked sandbox
//   qa janitor [--ttl <s>]                                     remove old runs and their leftovers
import { parseArgs } from 'node:util';
import { janitor } from './janitor.ts';
import { qaRun } from './run.ts';
import { FailSafeError } from './sandbox.ts';

const USAGE = `qa: the skills catalog's QA tools

  qa run [--timeout <seconds>] [--ttl <seconds>] -- <command> [args…]
      Runs the command in a fresh sandbox ($TMPDIR/skills-catalog-qa/<run-id>/) with SKILLS_* pointing into it, in its own
      process group; tears everything down on pass, fail, timeout or Ctrl-C; then checks that nothing outside the sandbox
      changed. Exit: the command's code, 2 if something was left behind, 124 on timeout, 130 on Ctrl-C.
  qa janitor [--ttl <seconds>]
      Removes runs older than the TTL (default 1 hour) and their leftovers.`;

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
    default:
      return console.error(USAGE), 1;
  }
}

main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
  console.error(e instanceof FailSafeError ? e.message : e);
  process.exit(e instanceof FailSafeError ? 3 : 1);
});
