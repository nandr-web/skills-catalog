// What setup's summary tells the person about settings it never changes (setup build notes §7, §9; contract §6): an
// administrator's policy that would stop its MCP server or its hook, and an allow rule of the person's (or an
// administrator's) that would let the assistant take a person-only step without asking. Read only: each file with the one
// reader, an unusable one skipped (the permissive-mode line already names it).
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonFile } from './json-file.ts';
import { broadBashRule } from './permissive.ts';

const CAP = 1024 * 1024;
const SERVER = 'skills-catalog';
// The person-only steps a rule could let through (build notes §7's probes), and the person-only tools.
const PROBES = [`${SERVER} update x --accept`, `${SERVER} clear-kept`, `${SERVER} publish x --confirm c --name x --version 1 --files 1 --flags none --allow-suspected-secrets`];
const PERSON_ONLY_TOOLS = ['accept_held_update', 'publish_skill_to_catalog'];

export type ManagedKey = 'managed_mcp' | 'allow_managed_mcp_servers_only' | 'allowed_mcp_servers' | 'denied_mcp_servers' | 'strict_plugin_only_mcp' | 'strict_plugin_only_hooks' | 'allow_managed_hooks_only' | 'disable_all_hooks';
export type Notes = { managed: { key: ManagedKey; path: string }[]; personOnly: { file: string; rule: string }[] };

const glob = (pattern: string) => new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 's');

/** Whether a Bash allow rule matches a command, by Claude Code's documented semantics: `Bash` and `Bash(*)` match
 *  everything; `:*` at the end is ` *`; `*` matches any text, spaces included; a trailing ` *` also matches the bare
 *  command. */
export function bashRuleMatches(rule: string, command: string): boolean {
  const m = /^Bash(?:\((.*)\))?$/s.exec(rule.trim());
  if (!m) return false;
  if (m[1] === undefined || m[1].trim() === '*') return true;
  const p = m[1].replace(/:\*$/, ' *');
  if (glob(p).test(command)) return true;
  return p.endsWith(' *') && glob(p.slice(0, -2)).test(command);
}

/** Whether an allow rule lets the assistant take a person-only step without asking. */
export function personOnlyRule(rule: string): boolean {
  if (rule === `mcp__${SERVER}`) return true;
  if (rule.startsWith(`mcp__${SERVER}__`)) return PERSON_ONLY_TOOLS.some((t) => glob(rule).test(`mcp__${SERVER}__${t}`));
  return broadBashRule(rule) || PROBES.some((p) => bashRuleMatches(rule, p));
}

function readValue(path: string): Record<string, unknown> | undefined {
  const f = readJsonFile(path, CAP, { forWrite: false });
  return 'value' in f ? f.value : undefined;
}

/** The managed settings files, in Claude Code's reading order: managed-settings.json, then the drop-ins by name. */
function managedFiles(dir: string): string[] {
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(join(dir, 'managed-settings.d'))
      .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  } catch {
    // none
  }
  return [join(dir, 'managed-settings.json'), ...dropIns.map((f) => join(dir, 'managed-settings.d', f))];
}

const listed = (x: unknown) => Array.isArray(x) && x.some((e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>)['serverName'] === SERVER);

export function setupNotes(o: { managedDir: string; assistantHome: string; projectDir: string }): Notes {
  const managed: Notes['managed'] = [];
  const personOnly: Notes['personOnly'] = [];
  try {
    lstatSync(join(o.managedDir, 'managed-mcp.json'));
    managed.push({ key: 'managed_mcp', path: join(o.managedDir, 'managed-mcp.json') });
  } catch {
    // not there
  }
  const managedPaths = managedFiles(o.managedDir);
  const others = [join(o.assistantHome, '.claude', 'settings.json'), join(o.projectDir, '.claude', 'settings.json'), join(o.projectDir, '.claude', 'settings.local.json')];
  for (const path of [...managedPaths, ...others]) {
    const v = readValue(path);
    if (!v) continue;
    const isManaged = managedPaths.includes(path);
    if (isManaged) {
      if (v['allowManagedMcpServersOnly'] === true) managed.push({ key: 'allow_managed_mcp_servers_only', path });
      if (Array.isArray(v['allowedMcpServers']) && !listed(v['allowedMcpServers'])) managed.push({ key: 'allowed_mcp_servers', path });
      if (listed(v['deniedMcpServers'])) managed.push({ key: 'denied_mcp_servers', path });
      const strict = v['strictPluginOnlyCustomization'];
      if (strict === true || (Array.isArray(strict) && strict.includes('mcp'))) managed.push({ key: 'strict_plugin_only_mcp', path });
      if (strict === true || (Array.isArray(strict) && strict.includes('hooks'))) managed.push({ key: 'strict_plugin_only_hooks', path });
      if (v['allowManagedHooksOnly'] === true) managed.push({ key: 'allow_managed_hooks_only', path });
    }
    if (v['disableAllHooks'] === true) managed.push({ key: 'disable_all_hooks', path });
    const permissions = v['permissions'];
    const allow = typeof permissions === 'object' && permissions !== null ? (permissions as Record<string, unknown>)['allow'] : undefined;
    if (Array.isArray(allow)) for (const rule of allow) if (typeof rule === 'string' && personOnlyRule(rule)) personOnly.push({ file: path, rule });
  }
  // Each rule once with its file.
  const seen = new Set<string>();
  return { managed, personOnly: personOnly.filter((n) => !seen.has(`${n.file}\0${n.rule}`) && seen.add(`${n.file}\0${n.rule}`)) };
}
