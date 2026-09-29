// The CLI face's words: the same surface, with ${op} filled from its CLI names (the command to run, e.g.
// "skills-catalog install <name>") and each word's `_cli` sibling in place of the word, since the command's own output is
// read by a person, or by an assistant that ran it in a shell and can't call the MCP tools from there.
import { Surface } from '@skills-catalog/core';

const CLI_NAMES = '__cli_face';

// A word's `_cli` sibling replaces it, at every level.
function preferCli(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(preferCli);
  if (!obj || typeof obj !== 'object') return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = preferCli(v);
  for (const k of Object.keys(out)) if (k.endsWith('_cli')) out[k.slice(0, -'_cli'.length)] = out[k];
  return out;
}

export function cliSurface(s: Surface): Surface {
  const doc = structuredClone(s.doc);
  const names = doc.names?.cli;
  // A surface with no CLI names yet keeps the tool names (the vendored words before the CLI face's).
  if (names) {
    doc.names[CLI_NAMES] = Object.fromEntries(Object.entries(names as Record<string, string>).map(([k, v]) => [k, v.replaceAll('${cli}', s.cli)]));
    doc.variants[s.variant] = { ...doc.variants[s.variant], names: CLI_NAMES };
  }
  doc.results = preferCli(doc.results);
  return new Surface(doc, s.variant);
}
