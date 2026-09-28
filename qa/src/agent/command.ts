// The exact headless Claude Code command per setup (qa-plan §3.1-3.2; brief §2.2-2.3), and its MCP config.
// Built-in tools stay on, as in real use. The setup's tools are allowed; every other request goes to the stand-in person
// (`--permission-prompt-tool`), who approves only what the scenario agrees to. The fallback, if the stand-in can't work,
// is `--permission-mode dontAsk` with the agreed operations added to the allowed list.
import { fileURLToPath } from 'node:url';
import type { Surface } from './surface.ts';

export type Setup = { name: string; mcp: boolean; allowed: string[]; companionSkill: boolean; cliOnPath: boolean };
export const PERSON_TOOL = 'mcp__qa-person__approve';
const PERSON_SERVER = fileURLToPath(new URL('./person.ts', import.meta.url));

export function SETUPS_FROM(raw: Record<string, { mcp: boolean; allowed: string[]; companion_skill: boolean; cli_on_path: boolean }>): Record<string, Setup> {
  return Object.fromEntries(Object.entries(raw).map(([name, s]) => [name, { name, mcp: s.mcp, allowed: s.allowed, companionSkill: s.companion_skill, cliOnPath: s.cli_on_path }]));
}

/** An allowed entry is an operation (mapped to the variant's MCP tool) or a Claude Code tool rule as written ("Skill", "Bash(skills *)"). */
const allowedTool = (surface: Surface, a: string) => (surface.key(a) ? surface.tool(a) : a);

export function claudeCommand(o: { ask: string; model: string; setup: Setup; surface: Surface; mcpConfig: string; budgetUsd: number; fallback?: { agreesTo: string[] } }): string[] {
  const allowed = o.setup.allowed.map((a) => allowedTool(o.surface, a));
  if (o.fallback) allowed.push(...o.fallback.agreesTo.map((a) => allowedTool(o.surface, a)));
  return [
    'claude', '-p', o.ask, '--model', o.model, '--no-session-persistence', '--setting-sources', 'project',
    ...(o.fallback ? ['--permission-mode', 'dontAsk'] : ['--permission-prompt-tool', PERSON_TOOL, '--permission-prompts', 'host']),
    '--max-budget-usd', String(o.budgetUsd), '--strict-mcp-config', '--mcp-config', o.mcpConfig,
    '--allowedTools', allowed.join(','),
    '--output-format', 'stream-json', '--verbose',
  ];
}

export function mcpConfig(o: { setup: Setup; surface: Surface; catalog: string[]; env: Record<string, string>; person: { agreesTo: string[]; log: string } }) {
  const servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {};
  if (o.setup.mcp) servers[o.surface.server] = { command: o.catalog[0], args: o.catalog.slice(1), env: o.env };
  servers['qa-person'] = {
    command: process.execPath, args: [PERSON_SERVER],
    env: { QA_PERSON_LOG: o.person.log, QA_PERSON_AGREES: JSON.stringify(o.person.agreesTo.map((a) => allowedTool(o.surface, a))) },
  };
  return { mcpServers: servers };
}
