// `qa run -- <command>`: fail-safe, janitor, sandbox, before snapshot, the command in its own process group, teardown on
// every ending (pass, fail, timeout, SIGINT), after snapshot, and any difference fails the run (qa-plan §6; brief §1).
// Everything runs on a fake machine (test/machine.ts); the check on the real machine is a script run by hand
// (test/live/qa-run-real.ts), never a test.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { qaRun } from '../src/run.ts';
import { compare, snapshot, watchOn } from '../src/check.ts';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, PROCESS_TEST_MS, machine, qaSpawn } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

afterEach(cleanup);

const node = (code: string) => [process.execPath, '-e', code];
const alive = (pid: number, group = true) => { try { process.kill(group ? -pid : pid, 0); return true; } catch { return false; } };

describe('qa run', () => {
  it('passes a command that stays in its sandbox, and removes the sandbox', async () => {
    const m = machine();
    const r = await qaRun({ machine: m, command: node(`require('fs').writeFileSync(process.env.SKILLS_HOME + '/lock.json', '{}')`) });
    expect(r).toMatchObject({ status: 'pass', exitCode: 0, differences: [] });
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] tears down after a failing command too', async () => {
    const m = machine();
    const r = await qaRun({ machine: m, command: node('process.exit(3)') });
    expect(r).toMatchObject({ status: 'fail', exitCode: 3 });
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] tears down after a timeout, killing the whole process group', async () => {
    const m = machine();
    let pgid = 0;
    const r = await qaRun({ machine: m, command: ['sh', '-c', 'sleep 30 & sleep 30'], timeoutMs: 300, onStart: (_, pid) => { pgid = pid; } });
    expect(r.status).toBe('timeout');
    expect(alive(pgid)).toBe(false);
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('with no time limit (timeoutMs Infinity: an attached demo), a run lasts as long as its command', async () => {
    const m = machine();
    const r = await qaRun({ machine: m, command: node('setTimeout(() => {}, 300)'), timeoutMs: Infinity });
    expect(r).toMatchObject({ status: 'pass', exitCode: 0 });
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] tears down when interrupted', async () => {
    const m = machine();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const r = await qaRun({ machine: m, command: ['sleep', '30'], signal: stop.signal });
    expect(r.status).toBe('interrupted');
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[6] the leaky canary: a command that writes outside its sandbox fails the run, even with exit code 0', async () => {
    const m = machine();
    const leak = join(m.home, '.claude', 'skills', 'canary-leak');
    const r = await qaRun({ machine: m, command: node(`require('fs').mkdirSync(${JSON.stringify(leak)})`) });
    expect(r.status).toBe('leak');
    expect(r.differences.map((d) => d.what)).toEqual([`added folder ${leak}`]);
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] never deletes a session folder a command names: ids written into the sandbox aren\'t trusted', async () => {
    const m = machine();
    const id = '00000000-0000-4000-8000-000000000001';
    const theirs = join(m.home, '.claude', 'session-env', id);
    mkdirSync(theirs);                                            // another session's, alive before the run
    const r = await qaRun({
      machine: m,
      command: node(`require('fs').appendFileSync(require('path').join(process.env.QA_SANDBOX, 'sessions.jsonl'), JSON.stringify(${JSON.stringify(id)}) + '\\n')`),
    });
    expect(r).toMatchObject({ status: 'pass', differences: [] });
    expect(existsSync(theirs)).toBe(true);
  });

  it('[6] a leak into the product\'s default place fails the run', async () => {
    const m = machine();
    const leak = join(m.home, '.skills-catalog', 'lock.json');
    const r = await qaRun({ machine: m, command: node(`const fs = require('fs'); fs.mkdirSync(${JSON.stringify(join(m.home, '.skills-catalog'))}); fs.writeFileSync(${JSON.stringify(leak)}, '{}')`) });
    expect(r.status).toBe('leak');
    expect(r.differences.map((d) => d.what)).toEqual([`added folder ${join(m.home, '.skills-catalog')}`, `added file ${leak}`]);
  });

  it('[6] a process that escapes the run\'s process group fails the run, and is stopped', async () => {
    const m = machine();
    // The test stops its own fixture, never through the code under test: if the check it tests fails to see the listener
    // (a sandbox that hides environments), stopEscaped can't either. By its exact pid, and only while that pid is still
    // this listener; the listener also ends itself after a minute.
    onTestFinished(() => {
      const file = join(m.tmp, 'escaped.pid');
      if (!existsSync(file)) return;
      const pid = Number(readFileSync(file, 'utf8'));
      const command = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
      if (pid > 0 && command.includes('QA-ESCAPED-LISTENER')) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    });
    // the command starts a listener in a process group of its own, then exits 0 once it listens (it says so on stdout),
    // so the after snapshot sees the port however long the listener took to start
    const r = await qaRun({
      machine: m,
      command: node(`const c = require('child_process').spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1', () => console.log('listening')); setTimeout(() => process.exit(0), 60000) /* QA-ESCAPED-LISTENER */"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
        require('fs').writeFileSync(require('path').join(process.env.QA_SANDBOX, '..', '..', 'escaped.pid'), String(c.pid)); c.stdout.once('data', () => process.exit(0));`),
    });
    expect(r.status).toBe('leak');
    const whats = r.differences.map((d) => d.what);
    expect(whats.some((w) => /^process \d+ from this run still running/.test(w)), whats.join('\n')).toBe(true);
    expect(whats.some((w) => /^port 127\.0\.0\.1:\d+ still listening/.test(w)), whats.join('\n')).toBe(true);
    expect(r.stopped.length).toBe(1);
    expect(alive(r.stopped[0], false)).toBe(false);
  });

  it('a run starts only after the fail-safe and the janitor, never in an unsafe base', async () => {
    const m = machine();
    await qaRun({ machine: m, command: ['true'] });
    const base = sandboxBase(m.tmp);
    const { chmodSync } = await import('node:fs');
    chmodSync(base, 0o755);
    await expect(qaRun({ machine: m, command: ['true'] })).rejects.toThrow(/0700/);
    expect(readdirSync(base)).toEqual([]);
  });
});

describe('qa run on the command line', () => {
  it('[3] SIGINT tears down and exits 130', async () => {
    const m = machine();
    const p = qaSpawn(m, ['run', '--', 'sleep', '30']);
    let err = '';
    const sandbox = await new Promise<string>((ok) => p.stderr!.on('data', (b) => { err += b; const x = err.match(/sandbox (\S+)/); if (x) ok(x[1]); }));
    expect(sandbox.startsWith(m.tmp)).toBe(true);
    expect(existsSync(sandbox)).toBe(true);
    p.kill('SIGINT');
    const code = await new Promise((ok) => p.on('exit', ok));
    expect(code).toBe(130);
    expect(existsSync(sandbox)).toBe(false);
  });

  it('[7] qa run itself leaves nothing behind, on the fake machine', async () => {
    const m = machine();
    const every = watchOn(m, { sandboxRoot: sandboxBase(m.tmp) });   // its slug prefixes every qa run's leftover names
    const before = snapshot(every);
    const p = qaSpawn(m, ['run', '--', process.execPath, '-e', `require('fs').writeFileSync(process.env.SKILLS_HOME + '/x', '1')`]);
    let err = '';
    p.stderr!.on('data', (b) => { err += b; });
    const code = await new Promise((ok) => p.on('exit', ok));
    expect(code, err).toBe(0);
    expect(existsSync(err.match(/sandbox (\S+)/)![1])).toBe(false);
    expect(compare(before, snapshot(every))).toEqual([]);
    expect(err).toMatch(process.platform === 'darwin' ? /nothing left behind/ : /processes not checked on this system yet/);
  });

});
