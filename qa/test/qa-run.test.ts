// `qa run -- <command>`: janitor, sandbox + fail-safe, before snapshot, the command in its own process group, teardown on
// every ending (pass, fail, timeout, SIGINT), after snapshot, and any difference fails the run (qa-plan §6; brief §1).
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { qaRun } from '../src/run.ts';
import { compare, realWatch, snapshot } from '../src/check.ts';
import { sandboxBase } from '../src/sandbox.ts';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-test-')));
  made.push(root);
  const m = { tmp: join(root, 'tmp'), home: join(root, 'home'), claudeTmp: join(root, 'private-tmp-claude') };
  for (const d of [m.tmp, join(m.home, '.claude', 'skills'), join(m.home, '.claude', 'projects'), join(m.home, '.claude', 'session-env'), m.claudeTmp]) mkdirSync(d, { recursive: true });
  return {
    ...m,
    opts: {
      tmp: m.tmp, home: m.home,
      roots: { claudeDir: join(m.home, '.claude'), claudeTmp: m.claudeTmp },
      productDefaults: [join(m.home, '.skills-catalog')],
      claudeJson: join(m.home, '.claude.json'), settingsJson: join(m.home, '.claude', 'settings.json'),
    },
  };
}
const node = (code: string) => [process.execPath, '-e', code];
const alive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

describe('qa run', () => {
  it('passes a command that stays in its sandbox, and removes the sandbox', async () => {
    const m = machine();
    const r = await qaRun({ ...m.opts, command: node(`require('fs').writeFileSync(process.env.SKILLS_HOME + '/lock.json', '{}')`) });
    expect(r).toMatchObject({ status: 'pass', exitCode: 0, differences: [] });
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] tears down after a failing command too', async () => {
    const m = machine();
    const r = await qaRun({ ...m.opts, command: node('process.exit(3)') });
    expect(r).toMatchObject({ status: 'fail', exitCode: 3 });
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] tears down after a timeout, killing the whole process group', async () => {
    const m = machine();
    let pgid = 0;
    const r = await qaRun({ ...m.opts, command: ['sh', '-c', 'sleep 30 & sleep 30'], timeoutMs: 300, onStart: (_, pid) => { pgid = pid; } });
    expect(r.status).toBe('timeout');
    expect(alive(pgid)).toBe(false);
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] tears down when interrupted', async () => {
    const m = machine();
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 200);
    const r = await qaRun({ ...m.opts, command: ['sleep', '30'], signal: stop.signal });
    expect(r.status).toBe('interrupted');
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[6] the leaky canary: a command that writes outside its sandbox fails the run, even with exit code 0', async () => {
    const m = machine();
    const leak = join(m.home, '.claude', 'skills', 'canary-leak');
    const r = await qaRun({ ...m.opts, command: node(`require('fs').mkdirSync(${JSON.stringify(leak)})`) });
    expect(r.status).toBe('leak');
    expect(r.differences.map((d) => d.what)).toEqual([`added folder ${leak}`]);
    expect(existsSync(r.sandbox)).toBe(false);
  });

  it('[3] removes what an assistant session left, keyed by the session id the command recorded', async () => {
    const m = machine();
    const sessionEnv = join(m.home, '.claude', 'session-env', 's-1');
    const r = await qaRun({
      ...m.opts,
      command: node(`const fs = require('fs'), path = require('path');
        fs.appendFileSync(path.join(process.env.QA_SANDBOX, 'sessions.jsonl'), JSON.stringify('s-1') + '\\n');
        fs.mkdirSync(${JSON.stringify(sessionEnv)}, { recursive: true });`),
    });
    expect(r).toMatchObject({ status: 'pass', differences: [] });
    expect(existsSync(sessionEnv)).toBe(false);
  });

  it('[6] a leak into the product\'s default place fails the run', async () => {
    const m = machine();
    const leak = join(m.home, '.skills-catalog', 'lock.json');
    const r = await qaRun({ ...m.opts, command: node(`const fs = require('fs'); fs.mkdirSync(${JSON.stringify(join(m.home, '.skills-catalog'))}); fs.writeFileSync(${JSON.stringify(leak)}, '{}')`) });
    expect(r.status).toBe('leak');
    expect(r.differences.map((d) => d.what)).toEqual([`added folder ${join(m.home, '.skills-catalog')}`, `added file ${leak}`]);
  });
});

describe('qa run on the command line', () => {
  const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

  it('[3] SIGINT tears down and exits 130', async () => {
    const p = spawn(process.execPath, [cli, 'run', '--', 'sleep', '30'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const sandbox = await new Promise<string>((ok) => p.stderr.on('data', (b) => { err += b; const m = err.match(/sandbox (\S+)/); if (m) ok(m[1]); }));
    expect(existsSync(sandbox)).toBe(true);
    p.kill('SIGINT');
    const code = await new Promise((ok) => p.on('exit', ok));
    expect(code).toBe(130);
    expect(existsSync(sandbox)).toBe(false);
  });

  it('[7] qa run itself leaves nothing behind (the check run on the real places, around qa run)', async () => {
    // Reads the real ~/.claude, ~/.claude.json and the product's default places; writes nothing there.
    const every = { sandboxRoot: sandboxBase() };   // its slug prefixes every qa run's leftover names
    const before = snapshot(realWatch(every));
    const p = spawn(process.execPath, [cli, 'run', '--', process.execPath, '-e', `require('fs').writeFileSync(process.env.SKILLS_HOME + '/x', '1')`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', (b) => { err += b; });
    const code = await new Promise((ok) => p.on('exit', ok));
    expect(code, err).toBe(0);
    const sandbox = err.match(/sandbox (\S+)/)![1];
    expect(existsSync(sandbox)).toBe(false);
    expect(compare(before, snapshot(realWatch(every)))).toEqual([]);
    expect(err).toMatch(/nothing left behind/);
  });
});
