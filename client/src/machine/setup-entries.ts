// What setup writes into the assistant's files (setup build notes §2, §7): the MCP entry, the session-start hook's group
// and the allow rules. Each is built from the settings setup itself ran with and from the API's rows, never typed here.

import { OPERATIONS, type OperationDef, type Words } from '@skills-catalog/core';
import { COMMANDS } from '../cli/run.ts';

export { hookGroup, hookLine, mcpEntry, type SetupRun } from './setup-values.ts';

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
