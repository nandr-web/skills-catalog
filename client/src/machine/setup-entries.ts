// What setup writes into the assistant's files (setup build notes §2, §7): the MCP entry, the session-start hook's group
// and the allow rules. Each is built from the settings setup itself ran with and from the API's rows, never typed here.

import { OPERATIONS, type OperationDef, type Words } from '@skills-catalog/core';
import { COMMANDS } from '../cli/run.ts';

/** What a setup run knows about itself: node and the script by absolute path, the setup id, and its environment. */
export type SetupRun = { node: string; script: string; id: string; env: Readonly<Record<string, string | undefined>> };

// The settings that go with the entry and the hook, in this order, when setup ran with them (never SKILLS_AS: who acts is
// the config's `me`). SKILLS_SETUP_ID goes first in the entry and in --setup-id on the hook's line.
const CARRIED = ['SKILLS_HOME', 'SKILLS_CATALOG', 'SKILLS_ASSISTANT_HOME', 'SKILLS_MANAGED_SETTINGS', 'SKILLS_INSTALL_DIR', 'SKILLS_ACTIVITY_LOG'] as const;
const carried = (r: SetupRun): [string, string][] => CARRIED.flatMap((k) => (r.env[k] ? [[k, r.env[k]!] as [string, string]] : []));

export function mcpEntry(r: SetupRun): Record<string, unknown> {
  return { type: 'stdio', command: r.node, args: [r.script, 'mcp'], env: Object.fromEntries([['SKILLS_SETUP_ID', r.id], ...carried(r)]) };
}

// Single quotes keep every character as it is; a quote inside is closed, escaped and reopened, so a home folder with an
// apostrophe is quoted, never refused.
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;

/** The hook's shell line: the settings, node and the script, then the hook command. `|| true` keeps a session clean when
 *  the product or that node was removed without a teardown. */
export function hookLine(r: SetupRun): string {
  const words = [...carried(r).map(([k, v]) => `${k}=${quote(v)}`), quote(r.node), quote(r.script), 'hook', 'session-start', '--setup-id', r.id];
  return `${words.join(' ')} 2>/dev/null || true`;
}

/** One matcher group of its own (no matcher: every source), with a timeout that caps a hang. */
export const hookGroup = (r: SetupRun): Record<string, unknown> => ({ hooks: [{ type: 'command', command: hookLine(r), timeout: 10 }] });

// The two tools that change the installed skills and are still safe to run unasked (contract §6): their inputs can't
// choose where bytes come from or go, and anything flagged is held for the person. Every other writing tool asks.
export const PRE_ALLOWED_WRITES = ['install_shared_skill', 'update_installed_skills'] as const;

const reads = (face: 'mcp' | 'cli') => (o: OperationDef) => o.effect === 'reads' && o.faces.includes(face);

/** The allow rules: the MCP tools that only read (the API's rows with effect `reads`, in their order), then the two
 *  pre-allowed writes; behind `readRules`, the CLI commands whose operation only reads, each with any words after it;
 *  then a command pre-allowed bare, exactly. */
export function allowRules(s: Words, { readRules = false }: { readRules?: boolean } = {}): string[] {
  const tool = (o: OperationDef) => `mcp__${s.serverName}__${o.name}`;
  const writes = PRE_ALLOWED_WRITES.map((n) => OPERATIONS[n]!).filter((o) => o.faces.includes('mcp'));
  const commands = Object.entries(COMMANDS);
  const readCommands = readRules ? commands.filter(([, c]) => Object.hasOwn(OPERATIONS, c.op) && reads('cli')(OPERATIONS[c.op]!)).map(([name]) => `Bash(${s.cli} ${name} *)`) : [];
  const bare = commands.filter(([, c]) => c.preAllowBare).map(([name]) => `Bash(${s.cli} ${name})`);
  return [...Object.values(OPERATIONS).filter(reads('mcp')).map(tool), ...writes.map(tool), ...readCommands, ...bare];
}
