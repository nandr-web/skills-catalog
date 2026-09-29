// The before/after check fails closed (the QA plan §6.6): when it can't run ps or lsof, or they run and see nothing of
// this run, a run is refused before anything starts, never passed with "no processes left". Tools are given by full
// path (never looked up on PATH), and a test swaps in a blind one to prove the refusal.
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckBlind, DEFAULT_TOOLS, checkSees, runProcesses } from '../src/check.ts';
import { newRunId, qaRun } from '../src/run.ts';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, machine, PROCESS_TEST_MS, qaSync } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

afterEach(cleanup);

// A tool that runs and prints nothing: a check that trusted it would see no processes and no ports.
const BLIND = '/usr/bin/true';

describe('the process and port checks fail closed', () => {
  it('uses ps and lsof by their full paths', () => {
    expect(DEFAULT_TOOLS).toEqual({ ps: '/bin/ps', lsof: '/usr/sbin/lsof' });
  });

  it('a ps that is missing is an error, never "no processes"', () => {
    expect(() => runProcesses(newRunId(), { ...DEFAULT_TOOLS, ps: '/nonexistent/ps' })).toThrow(CheckBlind);
  });

  it('sees its own marker process and its port with the real tools', async () => {
    await expect(checkSees(newRunId())).resolves.toBeUndefined();
  });

  it('a ps that runs and sees nothing, or an lsof that sees no port, refuses', async () => {
    await expect(checkSees(newRunId(), { ...DEFAULT_TOOLS, ps: BLIND })).rejects.toThrow(/can't see this run's own marker process/);
    await expect(checkSees(newRunId(), { ...DEFAULT_TOOLS, lsof: BLIND })).rejects.toThrow(/can't see the port/);
    await expect(checkSees(newRunId(), { ...DEFAULT_TOOLS, lsof: '/nonexistent/lsof' })).rejects.toThrow(CheckBlind);
  });

  it('a machine without lsof: qa run says to install it and exits 3, with no sandbox and no command started', () => {
    const m = machine();
    const noLsof = fileURLToPath(new URL('./fixtures/no-lsof.mjs', import.meta.url));
    const marker = `${m.dir}/ran`;
    const r = qaSync(m, ['run', '--', '/usr/bin/touch', marker], { NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${noLsof}`.trim() });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toContain('needs lsof to check that it cleans up after itself, and it isn\'t installed. Install it (e.g. `sudo apt install lsof`) and run again.');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(sandboxBase(m.tmp)) ? readdirSync(sandboxBase(m.tmp)) : []).toEqual([]);
  });

  it('a run on a machine the check can\'t see is refused before anything starts: no sandbox, no command', async () => {
    const m = machine();
    await expect(qaRun({ machine: m, command: ['true'], tools: { ...DEFAULT_TOOLS, ps: BLIND } })).rejects.toThrow(CheckBlind);
    expect(existsSync(sandboxBase(m.tmp)) ? readdirSync(sandboxBase(m.tmp)) : []).toEqual([]);
  });
});
