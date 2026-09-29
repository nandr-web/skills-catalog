// The agent scenario runner's test setup, shared by agent-runner.test.ts and agent-runner-tries.test.ts: a fake machine
// with an out folder, a recorded trace for the fake `claude` to replay, and the runner's options around them.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { machine as fakeMachine } from './machine.ts';

export const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Call from afterEach: the fake claude's settings never reach the next test. */
export const forgetFakeClaude = () => { for (const k of Object.keys(process.env)) if (k.startsWith('QA_FAKE_CLAUDE_')) delete process.env[k]; };

export const machine = () => { const m = fakeMachine(); return { ...m, out: join(m.dir, 'out') }; };

/** The QA plan's direct-MCP spike trace, with the spike's stand-in tool renamed to this surface's search tool. */
export function traceFile(dir: string, fixture: string) {
  const t = readFileSync(here(`../fixtures/traces/${fixture}`), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills');
  const p = join(dir, fixture);
  writeFileSync(p, t);
  return p;
}

export const base = (m: ReturnType<typeof machine>) => ({
  scenariosFile: here('../golden/agent-scenarios.yaml'),
  queriesFile: here('../golden/queries.yaml'),
  phrasesFile: here('../golden/phrases.yaml'),
  surface: `${here('./fixtures/surface.yaml')}#proposed`,
  catalogCommand: [process.execPath, '-e', ''],
  cliCommand: [process.execPath, '-e', ''],
  claude: [process.execPath, here('./fixtures/fake-claude.mjs')],
  models: ['claude-haiku-4-5-20251001'],
  tries: 1,
  out: m.out,
  machine: m,
  productRepo: null,
});
