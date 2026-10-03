// What the system map is checked against, read from the code itself: the tools the MCP server serves, the CLI's
// commands, the API's operations, the requirements (qa/traceability.yaml) and the source files.
import { globSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { OPERATIONS } from '../../../core/src/api.ts';
import { Words } from '../../../core/src/words-file.ts';
import { SERVED } from '../../../client/src/cli/run.ts';
import { RUNS } from '../../../client/src/operations.ts';

export type Facts = {
  /** The MCP tools, exactly as the server lists them (client/src/mcp/server.ts: Words.toolDefs ∩ RUNS). */
  tools: Set<string>;
  /** Each of those tools' operation. */
  toolOps: Map<string, string>;
  /** The CLI's command words: its operation commands and its process commands (client/src/cli/run.ts SERVED). */
  commands: Set<string>;
  /** The API's operations, local and hosted (core/src/api.ts OPERATIONS). */
  operations: Set<string>;
  /** Each requirement in qa/traceability.yaml: its line there and its sentence. */
  requirements: Map<string, { line: number; text: string }>;
  /** Every source file of the system's packages, relative to the repo, with / between folders. */
  sources: string[];
  /** Does a path or glob (relative to the repo) match any file? */
  matches: (pattern: string) => string[];
};

/** The packages whose src/ folders the map must account for, file by file. */
export const PACKAGES = ['core', 'client', 'hosted', 'infra', 'qa'] as const;

const files = (root: string, pattern: string) =>
  globSync(pattern, { cwd: root }).filter((p) => statSync(join(root, p)).isFile()).map((p) => p.split('\\').join('/')).sort();

export function readFacts(root: string): Facts {
  const trace = readFileSync(join(root, 'qa', 'traceability.yaml'), 'utf8');
  const lines = trace.split('\n');
  const requirements = new Map<string, { line: number; text: string }>();
  for (const r of (parse(trace) as { requirements: { id: string; text: string }[] }).requirements) {
    const line = lines.findIndex((l) => l === `  - id: ${r.id}`) + 1;
    requirements.set(r.id, { line, text: r.text });
  }
  const served = Words.load().toolDefs().filter((d) => RUNS[d.op]);
  return {
    tools: new Set(served.map((d) => d.name)),
    toolOps: new Map(served.map((d) => [d.name, d.op])),
    commands: new Set(SERVED),
    operations: new Set(Object.keys(OPERATIONS)),
    requirements,
    sources: PACKAGES.flatMap((p) => files(root, `${p}/src/**/*`)),
    matches: (pattern) => files(root, pattern),
  };
}
