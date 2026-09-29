// A qa command a test starts (--fake-machine) watches its parent: when the test process is gone (it timed out, crashed or
// was killed), the command stops itself the way SIGTERM stops it, tearing down its run and the processes it started,
// instead of living on with nobody to stop it. Run by a person (no --fake-machine), nothing is watched: a person may
// start qa from a shell they then close, on purpose.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { runProcesses } from '../src/check.ts';
import { machineFor } from '../src/machine.ts';
import { testPid, watchParent } from '../src/parent-watch.ts';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, machine, qaDetached, qaOrphaned, type TestMachine } from './machine.ts';

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (ok: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
  return ok();
};
const LONG = ['run', '--', process.execPath, '-e', 'setTimeout(() => {}, 60000)'];

describe('watching the parent', () => {
  it('calls back once when the parent changes (the old one is gone and the process was taken over), and not before', async () => {
    let ppid = 4242;
    let gone = 0;
    const stop = watchParent(() => gone++, { ppid: () => ppid, everyMs: 5 });
    onTestFinished(stop);
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(0);
    ppid = 1;
    expect(await until(() => gone > 0, 1000)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(1);
  });

  it('a starter that exited before the command got going (the parent is already init\'s) counts as gone', async () => {
    let gone = 0;
    onTestFinished(watchParent(() => gone++, { ppid: () => 1, everyMs: 5 }));
    expect(await until(() => gone > 0, 1000)).toBe(true);
  });

  it('given the test\'s own pid, watches that process, whoever the parent is', async () => {
    let up = true;
    let gone = 0;
    onTestFinished(watchParent(() => gone++, { pid: 4242, ppid: () => 1, alive: () => up, everyMs: 5 }));
    await new Promise((r) => setTimeout(r, 40));
    expect(gone).toBe(0);
    up = false;
    expect(await until(() => gone > 0, 1000)).toBe(true);
    expect(testPid({ QA_TEST_PID: '4242' })).toBe(4242);
    for (const bad of ['', '1', '0', '-5', 'x', '1.5']) expect(testPid({ QA_TEST_PID: bad }), bad).toBeUndefined();
  });

  it('starts only for a fake machine: a person\'s run is never watched', () => {
    const started: string[] = [];
    const watch = () => (started.push('watch'), () => {});
    const real = () => ({ stub: 'the real machine' }) as never;
    machineFor(undefined, { watch, real });
    expect(started).toEqual([]);
    machineFor(machine().dir, { watch, real });
    expect(started).toEqual(['watch']);
  });
});

// The runs whose sandboxes are on a test machine (by their folder names).
const runsOf = (m: TestMachine) => (existsSync(sandboxBase(join(m.dir, 'tmp'))) ? readdirSync(sandboxBase(join(m.dir, 'tmp'))) : []);

// A test that ends early (a failure, a timeout) leaves its qa and the run's command: stopped here by the run's id.
afterEach(cleanup);

describe('a qa command and the test that started it', () => {
  it('left without its test, it ends itself', { timeout: 20_000 }, async () => {
    const qa = qaOrphaned(machine(), LONG);
    expect(await until(() => !alive(qa), 15_000)).toBe(true);
  });

  it('while its test lives, it runs on (the watch fires only on a change); stopped, it stops its run', { timeout: 30_000 }, async () => {
    const m = machine();
    const qa = qaDetached(m, LONG);
    // qa first checks it can see processes and ports (slower on a busy machine): wait for the run's command, then for
    // a few of the watch's rounds.
    expect(await until(() => runsOf(m).some((id) => runProcesses(id).length > 0), 20_000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500));
    expect(alive(qa.pid!)).toBe(true);
    const ids = runsOf(m);
    expect(ids).toHaveLength(1);
    const exited = new Promise((r) => qa.once('exit', r));
    qa.kill('SIGTERM');
    await exited;
    expect(runProcesses(ids[0]!)).toEqual([]);
  });
});
