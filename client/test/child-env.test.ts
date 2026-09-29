// The environment every process a test starts gets (server.ts's childEnv): nothing inherited, the tripwire `claude` found
// first, every home-like place and SKILLS_ root in the test's sandbox, and the fail-safe refusing any real place.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { childEnv, place, tripwireBin } from './server.ts';

describe('the environment of a process a test starts', () => {
  it('finds the tripwire when it looks up claude, whatever else is on PATH, and the tripwire fails and notes the run', () => {
    const p = place();
    const env = childEnv(p);
    const found = spawnSync('/bin/sh', ['-c', 'command -v claude'], { env, encoding: 'utf8' });
    expect(found.stdout.trim()).toBe(join(tripwireBin(p), 'claude'));
    const ran = spawnSync('/bin/sh', ['-c', 'claude --version'], { env, encoding: 'utf8' });
    expect([ran.status, existsSync(join(tripwireBin(p), 'ran'))]).toEqual([1, true]);
  });

  it('inherits nothing from the test\'s own process: CLAUDE_CONFIG_DIR and a token set there are unset in the child', () => {
    const saved = { dir: process.env['CLAUDE_CONFIG_DIR'], token: process.env['SKILLS_TEST_SENTINEL_TOKEN'] };
    process.env['CLAUDE_CONFIG_DIR'] = '/sentinel/claude-config';
    process.env['SKILLS_TEST_SENTINEL_TOKEN'] = 'sentinel-token';
    try {
      const out = spawnSync(process.execPath, ['-e', 'console.log(JSON.stringify([process.env.CLAUDE_CONFIG_DIR ?? null, process.env.SKILLS_TEST_SENTINEL_TOKEN ?? null]))'], { env: childEnv(place()), encoding: 'utf8' });
      expect(JSON.parse(out.stdout)).toEqual([null, null]);
    } finally {
      for (const [k, v] of [['CLAUDE_CONFIG_DIR', saved.dir], ['SKILLS_TEST_SENTINEL_TOKEN', saved.token]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('a child writing to "$HOME/x" writes into the test\'s sandbox', () => {
    const p = place();
    const env = childEnv(p);
    spawnSync('/bin/sh', ['-c', 'mkdir -p "$HOME" && echo hi > "$HOME/x"'], { env });
    expect(existsSync(join(p.osHome, 'x'))).toBe(true);
    expect(join(p.osHome, 'x').startsWith(p.dir)).toBe(true);
  });

  it('refuses a real home for any of the places it sets', () => {
    for (const k of ['HOME', 'XDG_CONFIG_HOME', 'SKILLS_HOME', 'SKILLS_ASSISTANT_HOME', 'SKILLS_MANAGED_SETTINGS', 'CLAUDE_CONFIG_DIR']) {
      expect(() => childEnv(place(), { [k]: homedir() }), k).toThrow(/fail-safe/);
    }
  });
});
