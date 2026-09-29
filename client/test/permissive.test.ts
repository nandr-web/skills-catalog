// How the installer tells a permissive mode (contract §5.3): it reads Claude Code's settings files as Claude Code does,
// managed (managed-settings.json, then managed-settings.d/ in order), then the project's settings.local.json and
// settings.json, then the user's; a single value comes from the highest file that sets it, lists merge. The modes, first
// found wins: auto, bypass (both from user or managed settings only), sandbox_auto_allow, broad_bash_rule, and unknown
// when a file that's there can't be used. Fixture trees in a sandbox home, project and managed folder, never the real ones.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { broadBashRule, permissiveMode } from '../src/machine/permissive.ts';
import { settingsFrom } from '../src/settings.ts';
import { place, type Place } from './server.ts';

type Files = { managed?: unknown; managed_d_10?: unknown; managed_d_20?: unknown; local?: unknown; project?: unknown; user?: unknown };
function tree(p: Place, files: Files) {
  const at = {
    managed: join(p.dir, 'managed', 'managed-settings.json'),
    managed_d_10: join(p.dir, 'managed', 'managed-settings.d', '10-team.json'),
    managed_d_20: join(p.dir, 'managed', 'managed-settings.d', '20-security.json'),
    local: join(p.dir, 'project', '.claude', 'settings.local.json'),
    project: join(p.dir, 'project', '.claude', 'settings.json'),
    user: join(p.osHome, '.claude', 'settings.json'),
  };
  for (const [k, v] of Object.entries(files)) {
    const path = at[k as keyof Files];
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof v === 'string' ? v : JSON.stringify(v));
  }
  mkdirSync(join(p.dir, 'project'), { recursive: true });
  return { at, settings: settingsFrom({ SKILLS_HOME: p.home, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: join(p.dir, 'managed') }, join(p.dir, 'project')) };
}
const modeOf = (files: Files) => permissiveMode(tree(place(), files).settings);

describe('the permissive mode, from the settings files', () => {
  it('none of them: the default mode', () => {
    expect(modeOf({})).toEqual({});
  });

  it('auto and bypass count only from user or managed settings, managed first', () => {
    expect(modeOf({ user: { permissions: { defaultMode: 'auto' } } })).toEqual({ mode: 'auto' });
    expect(modeOf({ user: { permissions: { defaultMode: 'bypassPermissions' } } })).toEqual({ mode: 'bypass' });
    expect(modeOf({ project: { permissions: { defaultMode: 'auto' } } })).toEqual({});
    expect(modeOf({ local: { permissions: { defaultMode: 'bypassPermissions' } } })).toEqual({});
    expect(modeOf({ managed: { permissions: { defaultMode: 'default' } }, user: { permissions: { defaultMode: 'auto' } } })).toEqual({});
    expect(modeOf({ managed: { permissions: { defaultMode: 'bypassPermissions' } }, user: { permissions: { defaultMode: 'auto' } } })).toEqual({ mode: 'bypass' });
    // Modes in which Claude Code still asks, or refuses, before a command outside the person's rules runs.
    for (const m of ['acceptEdits', 'plan', 'dontAsk', 'default']) expect([m, modeOf({ user: { permissions: { defaultMode: m } } })]).toEqual([m, {}]);
  });

  it('managed settings: managed-settings.d/ read after managed-settings.json in order, a later single value winning, blocks merged key by key, lists combined', () => {
    expect(modeOf({ managed: { permissions: { defaultMode: 'auto' } }, managed_d_10: { permissions: { defaultMode: 'default' } } })).toEqual({});
    expect(modeOf({ managed_d_10: { permissions: { defaultMode: 'default' } }, managed_d_20: { permissions: { defaultMode: 'bypassPermissions' } } })).toEqual({ mode: 'bypass' });
    expect(modeOf({ managed: { sandbox: { enabled: true } }, managed_d_10: { sandbox: { autoAllowBashIfSandboxed: false } } })).toEqual({});
    expect(modeOf({ managed: { permissions: { allow: ['Read'] } }, managed_d_20: { permissions: { allow: ['Bash(*)'] } } })).toEqual({ mode: 'broad_bash_rule' });
  });

  it('managed settings narrow the rest: a mode turned off there isn\'t counted, and managed-only rules leave the others out', () => {
    expect(modeOf({ managed: { permissions: { disableBypassPermissionsMode: 'disable' } }, user: { permissions: { defaultMode: 'bypassPermissions' } } })).toEqual({});
    expect(modeOf({ managed: { permissions: { disableAutoMode: 'disable' } }, user: { permissions: { defaultMode: 'auto' } } })).toEqual({});
    expect(modeOf({ user: { permissions: { disableAutoMode: 'disable', defaultMode: 'auto' } } })).toEqual({ mode: 'auto' });
    expect(modeOf({ managed: { allowManagedPermissionRulesOnly: true }, project: { permissions: { allow: ['Bash'] } } })).toEqual({});
    expect(modeOf({ managed: { allowManagedPermissionRulesOnly: true, permissions: { allow: ['Bash(env *)'] } } })).toEqual({ mode: 'broad_bash_rule' });
  });

  it('sandbox_auto_allow: the sandbox on, and auto-allow not turned off (it defaults to on); the highest file decides each', () => {
    expect(modeOf({ project: { sandbox: { enabled: true } } })).toEqual({ mode: 'sandbox_auto_allow' });
    expect(modeOf({ project: { sandbox: { enabled: true, autoAllowBashIfSandboxed: false } } })).toEqual({});
    expect(modeOf({ local: { sandbox: { enabled: false } }, user: { sandbox: { enabled: true } } })).toEqual({});
    expect(modeOf({ local: { sandbox: { autoAllowBashIfSandboxed: false } }, user: { sandbox: { enabled: true } } })).toEqual({});
  });

  it('broad_bash_rule: an allow rule from any file, the lists merged', () => {
    expect(modeOf({ project: { permissions: { allow: ['Read', 'Bash(git *)'] } }, user: { permissions: { allow: ['Bash(python3 *)'] } } })).toEqual({ mode: 'broad_bash_rule' });
    expect(modeOf({ project: { permissions: { allow: ['Bash(git *)', 'Bash(python3 scripts/check.py)'] } } })).toEqual({});
    // Keys this check doesn't read are left alone, whatever they're called.
    expect(modeOf({ user: { path: '/x', why: 'not_json', model: 'opus', permissions: { deny: ['Bash(rm *)'] } } })).toEqual({});
  });

  it('first found wins: auto, bypass, sandbox_auto_allow, broad_bash_rule', () => {
    expect(modeOf({ user: { permissions: { defaultMode: 'auto', allow: ['Bash'] }, sandbox: { enabled: true } } })).toEqual({ mode: 'auto' });
    expect(modeOf({ user: { permissions: { allow: ['Bash'] }, sandbox: { enabled: true } } })).toEqual({ mode: 'sandbox_auto_allow' });
  });

  it('a settings file that is there but can\'t be used is unknown, last in the order, and named with why for setup; a missing one is simply absent', () => {
    // wrong_type names the setting read with the wrong type, never its value.
    const cases: [Files, keyof Files, Record<string, string>][] = [
      [{ user: '{"permissions": ' }, 'user', { why: 'not_json' }],
      [{ user: '[]' }, 'user', { why: 'not_json' }],
      [{ project: { permissions: { allow: 'Bash' } } }, 'project', { why: 'wrong_type', key: 'permissions.allow' }],
      [{ project: { permissions: { allow: ['Read', 7] } } }, 'project', { why: 'wrong_type', key: 'permissions.allow' }],
      [{ user: { permissions: 'all' } }, 'user', { why: 'wrong_type', key: 'permissions' }],
      [{ local: { sandbox: { enabled: 'yes' } } }, 'local', { why: 'wrong_type', key: 'sandbox.enabled' }],
      [{ managed: { permissions: { defaultMode: 7 } } }, 'managed', { why: 'wrong_type', key: 'permissions.defaultMode' }],
      [{ managed_d_20: { allowManagedPermissionRulesOnly: 'yes' } }, 'managed_d_20', { why: 'wrong_type', key: 'allowManagedPermissionRulesOnly' }],
      [{ user: 'x'.repeat(1024 * 1024 + 1) }, 'user', { why: 'too_big' }],
    ];
    for (const [files, which, why] of cases) {
      const t = tree(place(), files);
      expect([which, permissiveMode(t.settings)]).toEqual([which, { mode: 'unknown', unusable: [{ path: t.at[which], ...why }] }]);
    }
    const p = place();
    const t = tree(p, {});
    mkdirSync(join(p.osHome, '.claude'), { recursive: true });
    writeFileSync(join(p.dir, 'elsewhere.json'), JSON.stringify({ permissions: { defaultMode: 'default' } }));
    symlinkSync(join(p.dir, 'elsewhere.json'), t.at.user);
    expect(permissiveMode(t.settings)).toEqual({ mode: 'unknown', unusable: [{ path: t.at.user, why: 'link' }] });
    // A mode found in the files that can be used comes first; the unusable one is still named.
    const q = tree(place(), { user: '{', project: { permissions: { allow: ['Bash'] } } });
    expect(permissiveMode(q.settings)).toEqual({ mode: 'broad_bash_rule', unusable: [{ path: q.at.user, why: 'not_json' }] });
  });
});

describe('an allow rule that lets every command through (broad_bash_rule)', () => {
  it('counts the rules §5.3 names, and not the narrow ones', () => {
    const broad = ['Bash', 'Bash(*)', 'PowerShell', 'PowerShell(*)', 'Bash(* --help *)', 'Bash(python3 *)', 'Bash(python3:*)', 'Bash(node*)', 'Bash(sh -c *)', 'Bash(python3 -c *)', 'Bash(uv run python *)', 'Bash(env *)', 'PowerShell(pwsh *)'];
    const narrow = ['Bash(git *)', 'Bash(python3 scripts/check.py)', 'Bash(npm run test:*)', 'Read', 'Edit(*)', 'WebFetch(domain:*)', 'Bash(ls)'];
    expect(broad.filter((r) => !broadBashRule(r))).toEqual([]);
    expect(narrow.filter((r) => broadBashRule(r))).toEqual([]);
  });
});
