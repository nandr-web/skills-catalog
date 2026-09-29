// A run leaves no temporary folder behind (test/temp-folders.ts): the canary, a test that leaves a child writing into its
// folder after it ends, makes its run fail, and the failure names the folder.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, scratch } from './machine.ts';

afterEach(cleanup);

const VITEST = fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url));
const FIXTURE = fileURLToPath(new URL('./fixtures/leftover/', import.meta.url));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('a folder a test made and left', () => {
  it('fails the run, which names it', { timeout: 60_000 }, async () => {
    const tmp = scratch('qa-canary-tmp-');   // the canary run's TMPDIR: its folders land in here, removed with it
    const out = join(tmp, 'canary.json');
    const r = spawnSync(process.execPath, [VITEST, 'run', '--root', FIXTURE], { encoding: 'utf8', env: { ...process.env, TMPDIR: tmp, CANARY_OUT: out }, timeout: 50_000 });
    const { folder, writer } = JSON.parse(readFileSync(out, 'utf8')) as { folder: string; writer: number };
    // the canary's writer ends by itself within 3 s; this test's own folder goes only after it has
    for (let waited = 0; waited < 10_000 && writer > 0 && alive(writer); waited += 50) await new Promise((ok) => setTimeout(ok, 50));
    expect(r.status, r.stdout + r.stderr).not.toBe(0);
    expect(r.stdout + r.stderr).toContain(folder);
  });
});
