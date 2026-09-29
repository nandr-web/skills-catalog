// The before/after check fails closed (the QA plan §6.6): when it can't run ps or lsof, or they run and see nothing of
// this run, a run is refused before anything starts, never passed with "no processes left". Tools are given by full
// path (never looked up on PATH), and a test swaps in a blind one to prove the refusal.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CheckBlind, DEFAULT_TOOLS, checkSees, procProcesses, runProcesses } from '../src/check.ts';
import { newRunId, qaRun } from '../src/run.ts';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, machine, PROCESS_TEST_MS, qaSync, scratch } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

afterEach(cleanup);

// A tool that runs and prints nothing: a check that trusted it would see no processes and no ports.
const BLIND = '/usr/bin/true';
// Where the processes are listed from goes blind: ps on macOS, /proc on Linux (an empty folder in its place).
const blindList = () => (DEFAULT_TOOLS.proc ? { ...DEFAULT_TOOLS, proc: scratch() } : { ...DEFAULT_TOOLS, ps: BLIND });

describe('the process and port checks fail closed', () => {
  it('uses ps and lsof by their full paths; on Linux, the processes from /proc', () => {
    if (process.platform === 'darwin') expect(DEFAULT_TOOLS).toEqual({ ps: '/bin/ps', lsof: '/usr/sbin/lsof' });
    if (process.platform === 'linux') expect(DEFAULT_TOOLS).toMatchObject({ proc: '/proc' });
  });

  it('a ps (or /proc) that is missing is an error, never "no processes"', () => {
    expect(() => runProcesses(newRunId(), { ps: '/nonexistent/ps', lsof: DEFAULT_TOOLS.lsof })).toThrow(CheckBlind);
    expect(() => runProcesses(newRunId(), { ...DEFAULT_TOOLS, proc: '/nonexistent/proc' })).toThrow(CheckBlind);
  });

  it('sees its own marker process and its port with the real tools', async () => {
    await expect(checkSees(newRunId())).resolves.toBeUndefined();
  });

  it('a ps that runs and sees nothing, or an lsof that sees no port, refuses', async () => {
    await expect(checkSees(newRunId(), blindList())).rejects.toThrow(/can't see this run's own marker process/);
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
    await expect(qaRun({ machine: m, command: ['true'], tools: blindList() })).rejects.toThrow(CheckBlind);
    expect(existsSync(sandboxBase(m.tmp)) ? readdirSync(sandboxBase(m.tmp)) : []).toEqual([]);
  });
});

// On Linux, a process's environment is /proc/<pid>/environ (NUL-separated, readable for this user's own processes); the
// tree below has the shape of a real one.
describe('the process list on Linux, from /proc', () => {
  const tree = () => {
    const proc = scratch('qa-proc-');
    const pid = (n: number, environ: string[], cmdline: string[]) => {
      mkdirSync(join(proc, String(n)));
      writeFileSync(join(proc, String(n), 'environ'), environ.map((e) => `${e}\0`).join(''));
      writeFileSync(join(proc, String(n), 'cmdline'), cmdline.map((a) => `${a}\0`).join(''));
    };
    pid(100, ['HOME=/home/dev', 'QA_RUN_ID=20260929T010203Z-abcd1234', 'PATH=/usr/bin'], ['/usr/bin/node', '-e', 'setTimeout(() => {}, 60000)']);
    pid(101, ['QA_RUN_ID=20260929T010203Z-abcd12345'], ['/usr/bin/sleep', '30']);   // a longer id that starts the same
    pid(102, ['PATH=/usr/bin'], ['/bin/sh', '-c', 'echo QA_RUN_ID=20260929T010203Z-abcd1234']);   // a mention in the arguments only
    pid(103, ['X=QA_RUN_ID=20260929T010203Z-abcd1234'], ['/usr/bin/sleep', '30']);   // inside another variable's value
    pid(104, ['QA_RUN_ID=20260929T010203Z-abcd1234'], ['/usr/bin/sleep', '30']);
    chmodSync(join(proc, '104', 'environ'), 0o000);   // not readable: someone else's, or gone
    mkdirSync(join(proc, 'self'));
    writeFileSync(join(proc, 'uptime'), '1.0 1.0\n');
    return proc;
  };

  it('lists this user\'s processes whose environment holds exactly QA_RUN_ID=<id>, with their command line', () => {
    expect(procProcesses('20260929T010203Z-abcd1234', tree())).toEqual([{ pid: 100, command: '/usr/bin/node -e setTimeout(() => {}, 60000)' }]);
  });

  it('only this user\'s: another user\'s process is never listed', () => {
    expect(procProcesses('20260929T010203Z-abcd1234', tree(), process.getuid!() + 1)).toEqual([]);
  });

  it('a /proc that can\'t be read makes the check blind', () => {
    expect(() => procProcesses('x', '/nonexistent/proc')).toThrow(CheckBlind);
  });
});
