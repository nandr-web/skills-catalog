// A variant of the agent-experience trials' agent-facing surface (agent-ux/surface.yaml#<variant>): what the tools are called and the
// companion skill's text. Scenarios name contract operations (any contract draft's name, or the surface's key); the
// runner maps them to this variant's tool names, and back when scoring.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Names } from './score.ts';

const CLI_VERB: Record<string, string> = { search: 'search', get: 'get', install: 'install', versions: 'history', diff: 'diff', update: 'update', status: 'status', policy: 'policy', publish: 'publish' };

export type Surface = ReturnType<typeof loadSurface>;

export function loadSurface(spec: string) {
  const [path, variant] = spec.split('#');
  const doc = parse(readFileSync(path, 'utf8'));
  const v = doc.variants?.[variant];
  if (!v) throw new Error(`surface ${path}: no variant ${JSON.stringify(variant)}; it has ${Object.keys(doc.variants ?? {}).join(', ')}`);
  const server: string = doc.server.name;
  const own: Record<string, string> = doc.names[v.names];
  const sets = Object.values(doc.names) as Record<string, string>[];

  /** The surface key for an operation named by key, alias, or any names set's tool name. */
  const key = (op: string): string | undefined => {
    if (op in own) return op;
    for (const set of sets) for (const [kk, name] of Object.entries(set)) if (name === op) return kk;
    return undefined;
  };
  const tool = (op: string): string => {
    const k = key(op);
    if (!k) throw new Error(`surface ${path}#${variant}: no operation ${JSON.stringify(op)}`);
    return `mcp__${server}__${own[k]}`;
  };
  const cli: string = doc.cli ?? 'skills';   // one name everywhere: the CLI, the package, the MCP server
  const fill = (text: string) => text.replace(/\$\{(\w+)\}/g, (m, k) => (k === 'cli' ? cli : own[k] ?? m));

  return {
    variant, server, key, tool, cli,
    fill,
    /** An ask as written, or `surface:<dotted key>` taken from this file and filled. */
    ask(spec: string): string {
      if (!spec.startsWith('surface:')) return spec;
      const path = spec.slice('surface:'.length);
      const text = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), doc);
      if (typeof text !== 'string') throw new Error(`surface ${path}: no text at ${JSON.stringify(path)}`);
      return fill(text);
    },
    /** Placeholders left unfilled, like `${nope}`: a run with one fails (the scenarios file's rule). */
    unfilled: (text: string): string[] => text.match(/\$\{[^}]*\}/g) ?? [],
    /** Every name a scenario might use for each operation → how it shows in a trace (the MCP tool, the CLI verb). */
    names(): Names {
      const ops: Record<string, string[]> = {};
      for (const k of Object.keys(own)) {
        const forms = [tool(k), `${cli} ${CLI_VERB[k] ?? k}`];
        for (const set of sets) if (set[k]) ops[set[k]] = forms;
        ops[k] = forms;
      }
      ops.setup = [`mcp__${server}__setup`, `${cli} setup`];   // setup is CLI-first (contract §6); a setup tool counts too
      return { ops, server };
    },
    companionSkill: (kind: 'mcp' | 'cli'): string => fill(doc.companion_skill[kind]),
    skillName: doc.companion_skill.name as string,
  };
}
