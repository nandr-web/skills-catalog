#!/usr/bin/env node
// A stand-in for the `claude` binary in the runner's tests: records how it was called (argv, cwd, the SKILLS_* settings,
// the MCP config and the companion skill it would see), then replays a recorded trace on stdout. Costs nothing.
// Its switches are QA_* settings, the only ones (besides the allow-list) a run passes on:
//   QA_FAKE_CLAUDE_TRACE (the trace to replay), QA_FAKE_CLAUDE_RECORD (copy the call record there), QA_FAKE_CLAUDE_PID
//   (write its pid there), QA_FAKE_CLAUDE_SLEEP_MS (wait first), QA_FAKE_CLAUDE_LEAK (make that folder, outside the
//   sandbox: a leak), QA_FAKE_CLAUDE_CRASH (exit 1 with no output), QA_FAKE_CLAUDE_ENV_OUT (record its environment),
//   QA_FAKE_CLAUDE_START_MCP (start each MCP server in its config as Claude Code does: its own environment plus the
//   server's `env`, then initialize it), QA_FAKE_CLAUDE_MCP_LOGS (the Claude cache folder to write each MCP server's log
//   in, as Claude Code does: <cache>/<working folder's slug>/mcp-logs-<server's slug>/<time>.jsonl).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const E = process.env;
const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write('0.0.0 (fake claude)\n');
  process.exit(0);
}
const mcp = argv[argv.indexOf('--mcp-config') + 1];
const config = JSON.parse(readFileSync(mcp, 'utf8'));
const skill = join(process.cwd(), '.claude', 'skills', 'shared-skills', 'SKILL.md');
if (E.QA_FAKE_CLAUDE_PID) writeFileSync(E.QA_FAKE_CLAUDE_PID, String(process.pid));
if (E.QA_FAKE_CLAUDE_ENV_OUT) writeFileSync(E.QA_FAKE_CLAUDE_ENV_OUT, JSON.stringify(E));
writeFileSync(join(E.QA_SANDBOX, 'fake-claude-call.json'), JSON.stringify({
  argv, cwd: process.cwd(),
  env: Object.fromEntries(Object.entries(E).filter(([k]) => k.startsWith('SKILLS_'))),
  mcp: config,
  skill: existsSync(skill) ? readFileSync(skill, 'utf8') : null,
  path0: E.PATH.split(':')[0],
  shims: existsSync(E.PATH.split(':')[0]) ? readdirSync(E.PATH.split(':')[0]) : [],
}));
// the tests read the call record from outside the sandbox (it's deleted at teardown)
if (E.QA_FAKE_CLAUDE_RECORD) writeFileSync(E.QA_FAKE_CLAUDE_RECORD, readFileSync(join(E.QA_SANDBOX, 'fake-claude-call.json')));
if (E.QA_FAKE_CLAUDE_START_MCP) {
  for (const s of Object.values(config.mcpServers)) {
    const p = spawn(s.command, s.args ?? [], { env: { ...E, ...(s.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
    await new Promise((ok) => {
      p.stdout.once('data', ok);
      p.on('exit', ok);
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: '0' } } }) + '\n');
    });
    p.kill();
  }
}
if (E.QA_FAKE_CLAUDE_MCP_LOGS) {
  const slug = (s) => s.replace(/[^A-Za-z0-9]/g, '-');
  for (const name of Object.keys(config.mcpServers)) {
    const dir = join(E.QA_FAKE_CLAUDE_MCP_LOGS, slug(process.cwd()), `mcp-logs-${slug(name)}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-09-29T01-00-00-000Z.jsonl'), JSON.stringify({ debug: `${name}: server started`, timestamp: '2026-09-29T01:00:00.000Z' }) + '\n');
  }
}
if (E.QA_FAKE_CLAUDE_SLEEP_MS) await new Promise((ok) => setTimeout(ok, Number(E.QA_FAKE_CLAUDE_SLEEP_MS)));
if (E.QA_FAKE_CLAUDE_LEAK) mkdirSync(E.QA_FAKE_CLAUDE_LEAK, { recursive: true });
if (E.QA_FAKE_CLAUDE_CRASH) process.exit(1);
process.stdout.write(readFileSync(E.QA_FAKE_CLAUDE_TRACE, 'utf8'));
