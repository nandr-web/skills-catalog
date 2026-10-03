// Every process a test starts gets one built environment, nothing inherited (the QA plan's rule): the tripwire claude
// first on PATH, the home-like places in the test's sandbox. A source scan keeps it so: a start with no env fails here.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { callsWithoutEnv, mkfifo, processEnv, spawnsWithoutEnv, tripwireBin } from './process-env.ts';
import { sandbox } from './sandbox.ts';

describe('the built environment of a process a test starts', () => {
  it('is the sandbox\'s and nothing else: the tripwire first on PATH, the home-like places in the sandbox', () => {
    const dir = sandbox();
    const env = processEnv(dir);
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']);
    expect(env['PATH']!.split(':')).toEqual([tripwireBin(dir), '/usr/bin', '/bin', dirname(process.execPath)]);
    for (const k of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) expect(env[k]!.startsWith(dir + '/'), k).toBe(true);
    const found = spawnSync('/bin/sh', ['-c', 'command -v claude; claude --version'], { env, encoding: 'utf8' });
    expect(found.stdout.split('\n')[0]).toBe(join(tripwireBin(dir), 'claude'));
    expect(found.status).not.toBe(0);
    expect(readFileSync(join(tripwireBin(dir), 'ran'), 'utf8')).toBe('claude --version\n');
  });

  it('refuses a place outside the test run\'s sandboxes', () => {
    expect(() => processEnv(dirname(sandbox()))).toThrow(/fail-safe/);
  });

  it('mkfifo makes the fifo with a built environment', () => {
    const fifo = join(sandbox(), 'f');
    mkfifo(fifo);
    expect(existsSync(fifo)).toBe(true);
  });
});

describe('the source scan for a process started with no env', () => {
  it('finds each start whose arguments give no env, and only those', () => {
    const text = [
      "import { spawn, spawnSync, execFileSync } from 'node:child_process';",
      "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1)'], { stdio: 'ignore' });",
      "spawnSync('sh', ['-c', 'x'], { env, encoding: 'utf8' });",
      "execFileSync('mkfifo', [p]);",
      "execFileSync('sh', ['-c', ')'], { env: processEnv(d) });",
      "db.exec('DROP TABLE t'); /x(y)/.exec(s);",
      'spawn(',
      "  'node', ['-e', `a(${b})`],",
      '  { stdio: "ignore" },',
      ');',
    ].join('\n');
    expect(callsWithoutEnv(text)).toEqual([2, 4, 7]);
  });

  it('refuses a child_process import under another name, which the scan couldn\'t see', () => {
    expect(callsWithoutEnv("import { spawn as run } from 'node:child_process';")).toEqual([1]);
    expect(callsWithoutEnv("import * as cp from 'node:child_process';")).toEqual([1]);
    expect(callsWithoutEnv("const cp = require('child_process');")).toEqual([1]);
  });

  it('core\'s tests start no process without one', () => {
    expect(spawnsWithoutEnv(import.meta.dirname)).toEqual([]);
  });
});
