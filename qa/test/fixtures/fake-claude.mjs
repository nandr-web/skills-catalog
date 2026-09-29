#!/usr/bin/env node
// A stand-in for the `claude` binary in the runner's tests: records how it was called (argv, cwd, the SKILLS_* settings,
// the MCP config and the companion skill it would see), then replays a recorded trace on stdout. Costs nothing.
// Test switches: FAKE_CLAUDE_PID (write its pid there), FAKE_CLAUDE_SLEEP_MS (wait first), FAKE_CLAUDE_LEAK (make that
// folder, outside the sandbox: a leak), FAKE_CLAUDE_CRASH (exit 1 with no output).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const mcp = argv[argv.indexOf('--mcp-config') + 1];
const skill = join(process.cwd(), '.claude', 'skills', 'shared-skills', 'SKILL.md');
if (process.env.FAKE_CLAUDE_PID) writeFileSync(process.env.FAKE_CLAUDE_PID, String(process.pid));
writeFileSync(join(process.env.QA_SANDBOX, 'fake-claude-call.json'), JSON.stringify({
  argv, cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SKILLS_'))),
  mcp: JSON.parse(readFileSync(mcp, 'utf8')),
  skill: existsSync(skill) ? readFileSync(skill, 'utf8') : null,
  path0: process.env.PATH.split(':')[0],
  shims: existsSync(process.env.PATH.split(':')[0]) ? readdirSync(process.env.PATH.split(':')[0]) : [],
}));
// the tests read the call record from outside the sandbox (it's deleted at teardown)
if (process.env.FAKE_CLAUDE_RECORD) writeFileSync(process.env.FAKE_CLAUDE_RECORD, readFileSync(join(process.env.QA_SANDBOX, 'fake-claude-call.json')));
if (process.env.FAKE_CLAUDE_SLEEP_MS) await new Promise((ok) => setTimeout(ok, Number(process.env.FAKE_CLAUDE_SLEEP_MS)));
if (process.env.FAKE_CLAUDE_LEAK) mkdirSync(process.env.FAKE_CLAUDE_LEAK, { recursive: true });
if (process.env.FAKE_CLAUDE_CRASH) process.exit(1);
process.stdout.write(readFileSync(process.env.FAKE_CLAUDE_TRACE, 'utf8'));
