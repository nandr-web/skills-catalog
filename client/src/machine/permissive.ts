// Whether the assistant runs commands without asking (contract §5.3, "How the installer tells"): read from Claude Code's
// settings files as Claude Code reads them, so a skill that tells the assistant to run a command can be held while a
// permissive mode is on. Read-only: every file is opened without following a link, read up to 1 MiB and never written. A
// file that isn't there is absent; one that is there but can't be used can't be ruled out, so it counts as permissive
// (`unknown`), and is named, with why, for setup's summary (never its contents). What this can't see, said plainly: a
// mode given for one session (--permission-mode, --settings), the macOS MDM profile, and Windows.

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../settings.ts';

export type PermissiveMode = 'auto' | 'bypass' | 'sandbox_auto_allow' | 'broad_bash_rule' | 'unknown';
export type Unusable = { path: string; why: 'unreadable' | 'too_big' | 'not_json' | 'link' | 'wrong_type' };
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
function shapeOk(v: unknown): v is Read {
  if (!isObject(v)) return false;
  const p = v['permissions'];
  const s = v['sandbox'];
  return (
    optional(p, (x) => isObject(x) && optional(x['defaultMode'], isString) && optional(x['allow'], (a) => Array.isArray(a) && a.every(isString)) && optional(x['disableBypassPermissionsMode'], isString) && optional(x['disableAutoMode'], isString)) &&
    optional(s, (x) => isObject(x) && optional(x['enabled'], isBoolean) && optional(x['autoAllowBashIfSandboxed'], isBoolean)) &&
    optional(v['allowManagedPermissionRulesOnly'], isBoolean)
  );
}

/** A settings file as found: absent (undefined), its values, or why it can't be used. */
function readSettings(path: string): { values: Read } | { unusable: Unusable } | undefined {
  const cant = (why: Unusable['why']) => ({ unusable: { path, why } });
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return undefined;
  }
  if (st.isSymbolicLink()) return cant('link');
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? undefined : cant(code === 'ELOOP' ? 'link' : 'unreadable');
  }
  try {
    if (!fstatSync(fd).isFile()) return cant('unreadable');
    const buf = Buffer.alloc(MAX_BYTES + 1);
    let n = 0;
    for (let got = 1; got > 0 && n <= MAX_BYTES; n += got) got = readSync(fd, buf, n, buf.length - n, null);
    if (n > MAX_BYTES) return cant('too_big');
    let v: unknown;
    try {
      v = JSON.parse(buf.subarray(0, n).toString('utf8'));
    } catch {
      return cant('not_json');
    }
    return shapeOk(v) ? { values: v } : cant('wrong_type');
  } catch {
    return cant('unreadable');
  } finally {
    closeSync(fd);
  }
}

/** Blocks merged key by key, a later single value winning and lists combined (managed-settings.d/). */
function merge(a: Read, b: Read): Read {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const was = out[k];
    if (Array.isArray(was) && Array.isArray(v)) out[k] = [...was, ...v];
    else if (isObject(was) && isObject(v)) out[k] = merge(was as Read, v as Read);
    else out[k] = v;
  }
  return out as Read;
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
  const read = (path: string): Read => {
    const r = readSettings(path);
    if (r === undefined) return {};
    if ('unusable' in r) {
      unusable.push(r.unusable);
      return {};
    }
    return r.values;
  };
  const dir = settings.managedSettings;
  let dropIns: string[] = [];
  try {
    dropIns = readdirSync(join(dir, 'managed-settings.d')).filter((f) => f.endsWith('.json')).sort();
  } catch {
    // no drop-in folder
  }
  const managed = [join(dir, 'managed-settings.json'), ...dropIns.map((f) => join(dir, 'managed-settings.d', f))].map(read).reduce(merge, {});
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
