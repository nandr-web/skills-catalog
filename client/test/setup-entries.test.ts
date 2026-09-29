// What setup writes into the assistant's files (setup build notes §2, §7; golden setup.mcp_entry, hook_line, allow_rules,
// never_rules): the MCP entry, the hook group with its shell line, and the allow rules, generated, never typed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATIONS, Words } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it, onTestFinished } from 'vitest';
import { PRE_ALLOWED_WRITES, allowRules, hookGroup, hookLine, mcpEntry } from '../src/machine/setup-entries.ts';

const S = Words.load();
const g = loadGolden('setup.yaml').setup as { mcp_entry: string; hook_line: string; allow_rules: string[]; never_rules: string[] };
const at = { H: '/sandbox/skills-home', A: '/sandbox/assistant', M: '/sandbox/managed', node: '/opt/node/bin/node', script: '/opt/pkg/src/cli.ts', id: '0123456789abcdef0123456789abcdef' };
const fill = (t: string, x = at) => t.replaceAll('$H', x.H).replaceAll('$A', x.A).replaceAll('$M', x.M).replaceAll('<node>', x.node).replaceAll('<script>', x.script).replaceAll('<id>', x.id);
const env = (x = at) => ({ SKILLS_HOME: x.H, SKILLS_ASSISTANT_HOME: x.A, SKILLS_MANAGED_SETTINGS: x.M, HOME: '/home/ana', SKILLS_AS: 'ana' });
const run = (x = at) => ({ node: x.node, script: x.script, id: x.id, env: env(x) });

describe('setup entries', () => {
  it('the MCP entry: stdio, node and the script by absolute path, and only the SKILLS_ settings setup ran with, the id first (never SKILLS_AS)', () => {
    expect(`${JSON.stringify(mcpEntry(run()), null, 2)}`).toBe(fill(g.mcp_entry));
  });

  it('every SKILLS_ setting that is set goes in, in the pinned order; an empty one is unset', () => {
    const all = { SKILLS_ACTIVITY_LOG: '/l', SKILLS_INSTALL_DIR: '/i', SKILLS_MANAGED_SETTINGS: '/m', SKILLS_ASSISTANT_HOME: '/a', SKILLS_CATALOG: '/c', SKILLS_HOME: '/h', SKILLS_OTHER: 'x' };
    const e = mcpEntry({ ...run(), env: { ...all, SKILLS_CATALOG: '' } }) as { env: Record<string, string> };
    expect(Object.keys(e.env)).toEqual(['SKILLS_SETUP_ID', 'SKILLS_HOME', 'SKILLS_ASSISTANT_HOME', 'SKILLS_MANAGED_SETTINGS', 'SKILLS_INSTALL_DIR', 'SKILLS_ACTIVITY_LOG']);
  });

  it('the hook: one group of one command, no matcher, a 10 s timeout, its line as the golden', () => {
    expect(hookLine(run())).toBe(fill(g.hook_line));
    expect(hookGroup(run())).toEqual({ hooks: [{ type: 'command', command: fill(g.hook_line), timeout: 10 }] });
  });

  it("an apostrophe in a path is quoted, and sh runs the script with those exact values", () => {
    // A stand-in for node, in a folder with an apostrophe too, prints the setting it was given and its arguments.
    const top = mkdtempSync(join(tmpdir(), 'setup-entries-'));
    onTestFinished(() => rmSync(top, { recursive: true, force: true }));
    const dir = join(top, "o'neil");
    mkdirSync(dir);
    const node = join(dir, 'node');
    writeFileSync(node, '#!/bin/sh\nprintf \'%s|\' "$SKILLS_HOME" "$@"\n', { mode: 0o755 });
    const x = { ...at, H: `${dir}/skills-home`, node, script: `${dir}/pkg/cli.ts` };
    const line = hookLine(run(x));
    const q = (v: string) => v.replaceAll("'", "'\\''");
    expect(line).toBe(`SKILLS_HOME='${q(x.H)}' SKILLS_ASSISTANT_HOME='${x.A}' SKILLS_MANAGED_SETTINGS='${x.M}' '${q(node)}' '${q(x.script)}' hook session-start --setup-id ${x.id} 2>/dev/null || true`);
    // The child's own environment points every home-like place into the temp folder, never the real ones.
    const childEnv = { PATH: '/usr/bin:/bin', HOME: top, XDG_CONFIG_HOME: top, XDG_DATA_HOME: top, CLAUDE_CONFIG_DIR: top, TMPDIR: top };
    expect(execFileSync('sh', ['-c', line], { env: childEnv }).toString()).toBe(`${x.H}|${x.script}|hook|session-start|--setup-id|${x.id}|`);
  });

  it("the allow rules: the seven MCP tools, then the bare update command, as the golden; none of the never rules", () => {
    expect(allowRules(S)).toEqual(g.allow_rules);
    for (const r of g.never_rules) expect(allowRules(S, { readRules: true })).not.toContain(r);
  });

  it('the read rules, behind their switch, come after the MCP tools and before update', () => {
    const rules = allowRules(S, { readRules: true });
    expect(rules.slice(7)).toEqual(['Bash(skills-catalog search *)', 'Bash(skills-catalog read *)', 'Bash(skills-catalog versions *)', 'Bash(skills-catalog diff *)', 'Bash(skills-catalog list *)', 'Bash(skills-catalog update)']);
  });

  it('the rules come from the rows: a new reads row adds its tool and its command rule; no other writing row ever appears', () => {
    const base = allowRules(S, { readRules: true });
    const row = { ...OPERATIONS['list_shared_skill_versions']!, name: 'look_at_shared_thing' };
    OPERATIONS['look_at_shared_thing'] = row;
    try {
      const rules = allowRules(S, { readRules: true });
      expect(rules.filter((r) => !base.includes(r))).toEqual([`mcp__${S.serverName}__look_at_shared_thing`]);
      OPERATIONS['look_at_shared_thing'] = { ...row, effect: 'writes_machine' };
      expect(allowRules(S, { readRules: true })).toEqual(base);
    } finally {
      delete OPERATIONS['look_at_shared_thing'];
    }
    const writing = Object.values(OPERATIONS).filter((o) => o.effect !== 'reads' && !(PRE_ALLOWED_WRITES as readonly string[]).includes(o.name));
    expect(writing.length).toBeGreaterThan(0);
    for (const o of writing) expect(base.join('\n')).not.toContain(`__${o.name}`);
    // Each pre-allowed write is a real row the assistant can call, and only changes this machine.
    for (const n of PRE_ALLOWED_WRITES) expect([OPERATIONS[n]?.effect, OPERATIONS[n]?.faces.includes('mcp')]).toEqual(['writes_machine', true]);
  });
});
