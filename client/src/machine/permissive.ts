// Whether the assistant runs commands without asking (contract §5.3, "How the installer tells"): read from Claude Code's
// settings files as Claude Code reads them, so a skill that tells the assistant to run a command can be held while a
// permissive mode is on. Read-only: every file is opened without following a link, read up to 1 MiB and never written. A
// file that isn't there is absent; one that is there but can't be used can't be ruled out, so it counts as permissive
// (`unknown`), and is named, with why, for setup's summary (never its contents). What this can't see, said plainly: a
// mode given for one session (--permission-mode, --settings), the macOS MDM profile, and Windows.

import { opendirSync, type Dir } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../settings.ts';
import { readJsonFile } from './json-file.ts';

export type PermissiveMode = 'auto' | 'bypass' | 'sandbox_auto_allow' | 'broad_bash_rule' | 'unknown';
export type Unusable = { path: string; why: 'unreadable' | 'too_big' | 'not_json' | 'link' | 'too_many_files' } | { path: string; why: 'wrong_type'; key: string };
export type Permissive = { mode?: PermissiveMode; unusable?: Unusable[] };

const MAX_BYTES = 1024 * 1024;

// The keys this check reads, and the type each must have when it's set.
type Read = {
  permissions?: { defaultMode?: string; allow?: string[]; disableBypassPermissionsMode?: string; disableAutoMode?: string };
  sandbox?: { enabled?: boolean; autoAllowBashIfSandboxed?: boolean };
  allowManagedPermissionRulesOnly?: boolean;
};
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const optional = (v: unknown, ok: (x: unknown) => boolean) => v === undefined || ok(v);
const isString = (v: unknown) => typeof v === 'string';
const isBoolean = (v: unknown) => typeof v === 'boolean';
// Each setting this check reads, by its dotted name, and the type it must have when it's set.
const isStrings = (a: unknown) => Array.isArray(a) && a.every(isString);
// The narrowing keys are read from managed settings only; anywhere else they're ignored, as any other key is.
const BLOCKS = (managed: boolean): Record<string, Record<string, (x: unknown) => boolean>> => ({
  permissions: { defaultMode: isString, allow: isStrings, ...(managed ? { disableBypassPermissionsMode: isString, disableAutoMode: isString } : {}) },
  sandbox: { enabled: isBoolean, autoAllowBashIfSandboxed: isBoolean },
});
const TOP = (managed: boolean): Record<string, (x: unknown) => boolean> => (managed ? { allowManagedPermissionRulesOnly: isBoolean } : {});
/** The name of the first setting read with the wrong type (a block that isn't one included), or undefined. */
function wrongType(v: Record<string, unknown>, managed: boolean): string | undefined {
  for (const [block, keys] of Object.entries(BLOCKS(managed))) {
    const b = v[block];
    if (b === undefined) continue;
    if (!isObject(b)) return block;
    for (const [k, ok] of Object.entries(keys)) if (!optional(b[k], ok)) return `${block}.${k}`;
  }
  for (const [k, ok] of Object.entries(TOP(managed))) if (!optional(v[k], ok)) return k;
  return undefined;
}

/** A settings file as found: absent (undefined), its values, or why it can't be used. */
function readSettings(path: string, managed: boolean): { values: Read } | { unusable: Unusable } | undefined {
  // The one reader of the person's settings-shaped files (setup reads them the same way), so a file gives the same why here
  // and in setup's summary. Read only: the owner and hard-link checks are a writer's, so those whys never come back here.
  const f = readJsonFile(path, MAX_BYTES, { forWrite: false });
  if ('absent' in f) return undefined;
  if ('why' in f) return { unusable: { path, why: f.why === 'other_user' || f.why === 'hard_linked' ? 'unreadable' : f.why } };
  const key = wrongType(f.value, managed);
  return key === undefined ? { values: f.value as Read } : { unusable: { path, why: 'wrong_type', key } };
}

/** Blocks merged key by key, a later single value winning and lists combined (managed-settings.d/). Only as deep as the
 *  keys this reads (a block, then its settings), so a drop-in nested as deep as a file allows can't overflow the stack;
 *  below that, the later value wins whole. */
function merge(a: Read, b: Read, depth = 2): Read {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const was = out[k];
    if (Array.isArray(was) && Array.isArray(v)) out[k] = [...was, ...v];
    else if (depth > 1 && isObject(was) && isObject(v)) out[k] = merge(was as Read, v as Read, depth - 1);
    else out[k] = v;
  }
  return out as Read;
}

// At most this many entries in managed-settings.d are read, each within MAX_BYTES (contract §5.3).
const MAX_DROP_INS = 64;

/** The names in managed-settings.d: none when it's absent or not a folder; unreadable when it can't be listed; too many
 *  past MAX_DROP_INS entries of any kind (listing stops there). Either of those makes the mode unknown. */
function listDropIns(path: string): string[] | 'unreadable' | 'too_many_files' {
  let d: Dir;
  try {
    d = opendirSync(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? [] : 'unreadable';
  }
  try {
    const names: string[] = [];
    for (let entry = d.readSync(); entry; entry = d.readSync()) {
      if (names.length === MAX_DROP_INS) return 'too_many_files';
      names.push(entry.name);
    }
    return names;
  } catch {
    return 'unreadable';
  } finally {
    d.closeSync();
  }
}

// A command that runs other code (§5.3's broad_bash_runners, fixed here; config can only add).
const RUNNERS = new Set(['python', 'python3', 'node', 'bash', 'sh', 'zsh', 'bun', 'deno', 'ruby', 'perl', 'php', 'pwsh', 'powershell', 'npx', 'bunx', 'uv', 'env', 'xargs', 'sudo', 'doas', 'nohup', 'timeout', 'time', 'command', 'exec', 'eval', 'nice', 'watch']);

/** An allow rule that lets every command through: all of Bash or PowerShell, or a `*` rule whose first word is a
 *  wildcard or a command that runs other code. */
export function broadBashRule(rule: string, runners: ReadonlySet<string> = RUNNERS): boolean {
  const m = /^(Bash|PowerShell)(?:\((.*)\))?$/.exec(rule.trim());
  if (!m) return false;
  const pattern = m[2];
  if (pattern === undefined || pattern.trim() === '*') return true;
  if (!pattern.includes('*')) return false;
  const first = pattern.trim().split(/\s+/)[0]!;
  return first.includes('*') || runners.has(first.replace(/:$/, ''));
}

/** The permissive mode Claude Code's settings files turn on, if any, first found wins: auto, bypass, sandbox_auto_allow,
 *  broad_bash_rule, then unknown when a file that's there couldn't be used. */
export function permissiveMode(settings: Settings, extraRunners: readonly string[] = []): Permissive {
  const unusable: Unusable[] = [];
  const read = (path: string, managed = false): Read => {
    const r = readSettings(path, managed);
    if (r === undefined) return {};
    if ('unusable' in r) {
      unusable.push(r.unusable);
      return {};
    }
    return r.values;
  };
  const dir = settings.managedSettings;
  const dropInDir = join(dir, 'managed-settings.d');
  const listed = listDropIns(dropInDir);
  if (listed === 'unreadable' || listed === 'too_many_files') unusable.push({ path: dropInDir, why: listed });
  // .json files only, no dotfiles, in byte order of their names.
  const dropIns = (Array.isArray(listed) ? listed : [])
    .filter((f) => f.endsWith('.json') && !f.startsWith('.'))
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  const managed = [join(dir, 'managed-settings.json'), ...dropIns.map((f) => join(dir, 'managed-settings.d', f))].map((f) => read(f, true)).reduce((a, b) => merge(a, b), {});
  const local = read(join(settings.projectDir, '.claude', 'settings.local.json'));
  const project = read(join(settings.projectDir, '.claude', 'settings.json'));
  const user = read(join(settings.assistantHome, '.claude', 'settings.json'));
  const highest = <T>(...xs: (T | undefined)[]) => xs.find((x) => x !== undefined);

  const mp = managed.permissions ?? {};
  const defaultMode = highest(mp.defaultMode, user.permissions?.defaultMode);
  const enabled = highest(managed.sandbox?.enabled, local.sandbox?.enabled, project.sandbox?.enabled, user.sandbox?.enabled);
  const autoAllow = highest(managed.sandbox?.autoAllowBashIfSandboxed, local.sandbox?.autoAllowBashIfSandboxed, project.sandbox?.autoAllowBashIfSandboxed, user.sandbox?.autoAllowBashIfSandboxed) ?? true;
  const allow = managed.allowManagedPermissionRulesOnly === true ? (mp.allow ?? []) : [managed, local, project, user].flatMap((f) => f.permissions?.allow ?? []);
  const runners = new Set([...RUNNERS, ...extraRunners]);

  const mode: PermissiveMode | undefined =
    defaultMode === 'auto' && mp.disableAutoMode !== 'disable'
      ? 'auto'
      : defaultMode === 'bypassPermissions' && mp.disableBypassPermissionsMode !== 'disable'
        ? 'bypass'
        : enabled === true && autoAllow !== false
          ? 'sandbox_auto_allow'
          : allow.some((r) => broadBashRule(r, runners))
            ? 'broad_bash_rule'
            : unusable.length
              ? 'unknown'
              : undefined;
  return { ...(mode ? { mode } : {}), ...(unusable.length ? { unusable } : {}) };
}
