// Runs one of core's scripts (scripts/*.ts) as a person runs it from the core folder, in a test's sandbox: its own
// home folder (which exists, as a person's does) and temp folder, nothing inherited. Returns what it printed.
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect } from 'vitest';
import { processEnv } from './process-env.ts';
import { sandbox } from './sandbox.ts';

export function runScript(script: string, args: string[] = []): string {
  const env = processEnv(sandbox());
  mkdirSync(env['HOME']!, { recursive: true });
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', 'scripts', script), ...args], {
    cwd: join(import.meta.dirname, '..'),
    env,
    encoding: 'utf8',
  });
  expect(r.status, r.stderr).toBe(0);
  expect(r.stderr).toBe('');
  return r.stdout;
}
