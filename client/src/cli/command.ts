// One CLI command: which registry operation it runs, the flags it takes, and how its words and flags become the
// operation's input. Each command lives in its own file (commands/), and run.ts reads, checks and runs them all the same
// way. A flag is an operation's input, --<field> with underscores as hyphens; a list is one comma-separated value, and
// `none` is the empty list, so every input is one visible token in a permission prompt (contract §1). The shorthands
// (install --project, read --files and --contents) and read's --path (a path may hold a comma) are the commands' own.
import { CatalogError, inputSchema, type Surface } from '@skills-catalog/core';
import type { Context } from '../operations.ts';

export type FlagType = { type: 'string' | 'boolean'; multiple?: boolean };
export type Values = Record<string, string | boolean | string[] | undefined>;

export type Io = {
  env: Record<string, string | undefined>;
  cwd: string;
  /** A person at a terminal can answer (stdin and stdout are both terminals). */
  tty: boolean;
  ask: (question: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

/** What a command's own run gets: the operation's context, the person's terminal, and what they typed. */
export type Env = { ctx: Context; s: Surface; io: Io; words: readonly string[]; values: Values; input: Record<string, unknown>; withActing: (text: string) => string };

/** A command's words and flags don't make an input: run.ts prints the usage and exits 1. */
export class Usage extends Error {}

export type Command = {
  /** The registry's operation; for a command that only runs on its own, its own name (stats). */
  op: string;
  /** The flags it takes, by name (no leading --). */
  flags: Record<string, FlagType>;
  /** Flags only the person may give: with no terminal, nothing is done and they get the command to run (exit 3). */
  personOnly?: readonly string[];
  /** The operation a person-only flag runs, when it isn't `op` (update --accept takes a held update): what its usage
   *  event counts. */
  personOnlyOp?: string;
  /** Reads the catalog and never writes it (setup may let an assistant run these without asking, contract §6). */
  readOnly?: boolean;
  /** Outcomes that aren't errors on every face but are a failure here (exit 1, on stderr): a read that found none of its
   *  names (contract §1). */
  failsOn?: readonly string[];
  /** The operation's input from the words after the command and its flags; Usage when they don't make one. */
  input(words: readonly string[], values: Values): Record<string, unknown>;
  /** A step of its own (update --accept asks the person) instead of the operation; undefined runs the operation. */
  run?(env: Env): Promise<number> | undefined;
};

type Schema = { type?: string; properties?: Record<string, Schema> };

type SchemaFlag = FlagType & { field: string; kind: 'string' | 'boolean' | 'integer' | 'list' };

export const kebab = (s: string) => s.replaceAll('_', '-');

/** The operation's own inputs as flags, all but `except` (those the command fills its own way). */
export function schemaFlags(op: string, except: readonly string[] = []): Record<string, SchemaFlag> {
  const props = (inputSchema(op, 'cli').properties ?? {}) as Record<string, Schema>;
  return Object.fromEntries(
    Object.entries(props)
      .filter(([k, v]) => !except.includes(k) && v.type !== 'object')
      .map(([k, v]) => {
        const kind = v.type === 'array' ? 'list' : v.type === 'boolean' ? 'boolean' : v.type === 'integer' ? 'integer' : 'string';
        return [kebab(k), { type: kind === 'boolean' ? 'boolean' : 'string', field: k, kind }];
      }),
  );
}

// A number where one is expected; anything else goes to the registry as typed, which refuses it in its own words.
const numberOr = (v: string): number | string => (/^-?\d+$/.test(v) ? Number(v) : v);

/** A list flag's value: comma-separated, `none` for the empty list. */
export const listOf = (v: string): string[] => (v === 'none' ? [] : v.split(','));

/** The inputs the schema's flags give, as the operation takes them. */
export function fromSchemaFlags(flags: Record<string, SchemaFlag>, values: Values): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, f] of Object.entries(flags)) {
    const v = values[key];
    if (typeof v !== 'string') {
      if (v !== undefined) args[f.field] = v;
      continue;
    }
    args[f.field] = f.kind === 'integer' ? numberOr(v) : f.kind === 'list' ? listOf(v) : v;
  }
  return args;
}

/** Two flags that say opposite things about one input (contract §1). */
export const contradicting = (field: string) => new CatalogError('invalid_request', { field, why: 'contradicting_flags' });

/** Positional words that fill named inputs one for one; any other count is a usage mistake. */
export function exactly(words: readonly string[], names: readonly string[]): Record<string, unknown> {
  if (words.length !== names.length) throw new Usage();
  return Object.fromEntries(names.map((n, i) => [n, words[i]]));
}
