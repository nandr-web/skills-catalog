// Setup's golden (qa/golden/setup.yaml) with its placeholders filled with fixed values, for the tests of setup's edits.
import { loadGolden } from '@skills-catalog/core/testing';
import { scanJson, type JsonContainer, type JsonNode } from '../src/machine/json-text.ts';

export const golden = loadGolden('setup.yaml').setup as Record<string, any>;
const FILL: [string, string][] = [['<node>', '/opt/node/bin/node'], ['<script>', '/opt/pkg/cli.ts'], ['<id>', '0123456789abcdef0123456789abcdef'], ['$H', '/h'], ['$A', '/a'], ['$M', '/m']];
export const LINE = 'the hook line';
export const fill = (s: string) => FILL.reduce((t, [k, v]) => t.split(k).join(v), s).split('<line>').join(LINE);
/** A golden file: {text, crlf?, final_newline?}, or plain text. */
export const fileOf = (f: string | { text: string; crlf?: boolean; final_newline?: boolean }) => {
  const g = typeof f === 'string' ? { text: f } : f;
  let t = fill(g.text);
  if (g.final_newline === false) t = t.replace(/\n$/, '');
  return g.crlf ? t.replace(/\n/g, '\r\n') : t;
};
export const MCP_ENTRY = JSON.parse(fill(golden.mcp_entry)) as Record<string, unknown>;
export const HOOK_GROUP = { hooks: [{ type: 'command', command: LINE, timeout: 10 }] };
export const RULES = golden.allow_rules as string[];

const everything = () => true;
/** The container at `keys` in `text`. */
export const at = (text: string, ...keys: string[]): JsonContainer => {
  let n: JsonNode = scanJson(text, everything);
  for (const k of keys) {
    if (n.kind !== 'object') throw new Error(`no ${k}`);
    n = n.members.find((m) => m.key === k)!.value;
  }
  if (n.kind !== 'object' && n.kind !== 'array') throw new Error('not a container');
  return n;
};
