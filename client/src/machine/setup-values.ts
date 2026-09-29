// The two values setup writes that carry its run (setup build notes §2): the MCP entry and the session-start hook's group,
// each built from node and the script by absolute path, the setup id and the settings setup ran with. Read back from a
// record, a value is setup's only when it's exactly what these build from its own parts, never when it merely contains
// the id.

import { jsonEqual } from './json-equal.ts';

/** What a setup run knows about itself: node and the script by absolute path, the setup id, and its environment. */
export type SetupRun = { node: string; script: string; id: string; env: Readonly<Record<string, string | undefined>> };

// The settings that go with the entry and the hook, in this order, when setup ran with them (never SKILLS_AS: who acts is
// the config's `me`). SKILLS_SETUP_ID goes first in the entry and in --setup-id on the hook's line.
export const CARRIED = ['SKILLS_HOME', 'SKILLS_CATALOG', 'SKILLS_ASSISTANT_HOME', 'SKILLS_MANAGED_SETTINGS', 'SKILLS_INSTALL_DIR', 'SKILLS_ACTIVITY_LOG'] as const;
const carried = (r: SetupRun): [string, string][] => CARRIED.flatMap((k) => (r.env[k] ? [[k, r.env[k]!] as [string, string]] : []));

export function mcpEntry(r: SetupRun): Record<string, unknown> {
  return { type: 'stdio', command: r.node, args: [r.script, 'mcp'], env: Object.fromEntries([['SKILLS_SETUP_ID', r.id], ...carried(r)]) };
}

// Single quotes keep every character as it is; a quote inside is closed, escaped and reopened, so a home folder with an
// apostrophe is quoted, never refused.
const quote = (v: string) => `'${v.replaceAll("'", "'\\''")}'`;
const TAIL = ' 2>/dev/null || true';

/** The hook's shell line: the settings, node and the script, then the hook command. `|| true` keeps a session clean when
 *  the product or that node was removed without a teardown. */
export function hookLine(r: SetupRun): string {
  const words = [...carried(r).map(([k, v]) => `${k}=${quote(v)}`), quote(r.node), quote(r.script), 'hook', 'session-start', '--setup-id', r.id];
  return `${words.join(' ')}${TAIL}`;
}

/** One matcher group of its own (no matcher: every source), with a timeout that caps a hang. */
export const hookGroup = (r: SetupRun): Record<string, unknown> => ({ hooks: [{ type: 'command', command: hookLine(r), timeout: 10 }] });

// A single-quoted word as hookLine writes it, at the start of the text: its value and the rest.
const QUOTED = /^'((?:[^']|'\\'')*)'/;
function quoted(text: string): [string, string] | undefined {
  const m = QUOTED.exec(text);
  return m ? [m[1]!.replaceAll("'\\''", "'"), text.slice(m[0].length)] : undefined;
}

/** The run a hook line was built from, or undefined when the line isn't exactly one hookLine builds. */
export function parseHookLine(line: string): SetupRun | undefined {
  let rest = line;
  const env: Record<string, string> = {};
  for (const k of CARRIED) {
    if (!rest.startsWith(`${k}=`)) continue;
    const q = quoted(rest.slice(k.length + 1));
    if (!q || !q[1].startsWith(' ')) return undefined;
    env[k] = q[0];
    rest = q[1].slice(1);
  }
  const node = quoted(rest);
  if (!node || !node[1].startsWith(' ')) return undefined;
  const script = quoted(node[1].slice(1));
  if (!script) return undefined;
  const m = /^ hook session-start --setup-id ([0-9a-f]{32})$/.exec(script[1].endsWith(TAIL) ? script[1].slice(0, -TAIL.length) : '');
  if (!m) return undefined;
  const run = { node: node[0], script: script[0], id: m[1]!, env };
  return hookLine(run) === line ? run : undefined;
}

/** Whether `value` is exactly the MCP entry setup builds with setup id `id` (from its own command, script and env). */
export function isOwnMcpEntry(value: unknown, id: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  const args = v['args'];
  const env = v['env'];
  if (typeof v['command'] !== 'string' || !Array.isArray(args) || typeof args[0] !== 'string' || typeof env !== 'object' || env === null) return false;
  if (!Object.values(env).every((x) => typeof x === 'string')) return false;
  return jsonEqual(value, mcpEntry({ node: v['command'], script: args[0], id, env: env as Record<string, string> }));
}

/** Whether `value` is exactly the hook group setup builds with setup id `id`. */
export function isOwnHookGroup(value: unknown, id: string): boolean {
  const hooks = (value as { hooks?: unknown } | null)?.hooks;
  const line = Array.isArray(hooks) && typeof hooks[0] === 'object' && hooks[0] !== null ? (hooks[0] as Record<string, unknown>)['command'] : undefined;
  const run = typeof line === 'string' ? parseHookLine(line) : undefined;
  return run !== undefined && run.id === id && jsonEqual(value, hookGroup(run));
}
