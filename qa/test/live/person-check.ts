// The live stand-in person check (brief §2.2), run by agent-live.test.ts as a child process on the real machine (the live
// runner, not a test process): Claude Code sends a permission prompt to the stand-in person, which refuses or approves as
// agreed. Usage: node test/live/person-check.ts '<agreed tools as JSON>'. Prints {person, denials, wrote} as JSON.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeCommand, mcpConfig } from '../../src/agent/command.ts';
import { loadSurface } from '../../src/agent/surface.ts';
import { parseTrace } from '../../src/agent/trace.ts';
import { realMachine } from '../../src/machine.ts';
import { childEnv, createSandbox, newRunId } from '../../src/sandbox.ts';
import { teardown } from '../../src/teardown.ts';

const agreesTo: string[] = JSON.parse(process.argv[2] ?? '[]');
const surface = loadSurface(`${fileURLToPath(new URL('../fixtures/surface.yaml', import.meta.url))}#proposed`);
const noCatalog = { name: 'none', mcp: false, allowed: [], companionSkill: false, cliOnPath: false };
// A request that always prompts in the default mode: writing a file (a harmless `echo` is auto-allowed, so it never asks).
const ask = 'Use the Write tool to create a file named qa-person-check.txt in the current folder, containing the word ok. Then say done, or say what stopped you.';

const machine = realMachine();
const envDir = join(machine.roots.claudeDir, 'session-env');
const sessionEnvsBefore = new Set(existsSync(envDir) ? readdirSync(envDir) : []);
const sb = createSandbox({ runId: newRunId(), machine });
let sessions: string[] = [];
try {
  const log = join(sb.root, 'person.jsonl'), cfg = join(sb.root, 'mcp.json');
  // Write is a built-in tool, which the runner's stand-in may never agree to; this check builds the config by hand.
  const config = mcpConfig({ setup: noCatalog, surface, catalog: [], env: sb.env, person: { agreesTo: [], log } });
  config.mcpServers['qa-person'].env.QA_PERSON_AGREES = JSON.stringify(agreesTo);
  writeFileSync(cfg, JSON.stringify(config));
  const cmd = claudeCommand({ ask, model: 'claude-haiku-4-5-20251001', setup: noCatalog, surface, mcpConfig: cfg, budgetUsd: 0.1 });
  const r = spawnSync(cmd[0], cmd.slice(1), { cwd: sb.dirs.work, env: childEnv(sb), encoding: 'utf8', timeout: 180_000 });
  const trace = parseTrace(r.stdout);
  sessions = trace.sessions;
  const person = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  console.log(JSON.stringify({ person, denials: trace.result?.permissionDenials.length ?? 0, wrote: existsSync(join(sb.dirs.work, 'qa-person-check.txt')) }));
} finally {
  await teardown(sb, { machine, sessions, sessionEnvsBefore });
}
