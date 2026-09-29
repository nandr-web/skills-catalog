// One rule for every process-group signal in qa: a group's number is still the group's while the leader qa started
// hasn't been reaped, or, once it has, while no process holds that number (the system never gives out a number still in
// use as a group's id, so a live process with it means the group emptied and the number is someone else's now).
import { spawn } from 'node:child_process';
import { describe, expect, it, onTestFinished } from 'vitest';
import { groupIsOurs, running, signalGroup } from '../src/groups.ts';
import { pidFrom } from '../src/pids.ts';
import { spawnDetached } from './machine.ts';

const G = 2 ** 30;   // above any system's highest pid: a real signal to it could reach no one
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (ok: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 25));
  return ok();
};

describe('whose a group\'s number is', () => {
  it('the leader qa started still running: the group\'s own', () => {
    expect(groupIsOurs(G, true, () => true)).toBe(true);
  });

  it('the leader gone and a live process holding the number: someone else\'s now', () => {
    expect(groupIsOurs(G, false, () => true)).toBe(false);
  });

  it('the leader gone and no process holding the number: the group\'s, if it still has members', () => {
    expect(groupIsOurs(G, false, () => false)).toBe(true);
  });

  it('a leader is running until node has seen it exit', () => {
    expect(running({ exitCode: null, signalCode: null })).toBe(true);
    expect(running({ exitCode: 0, signalCode: null })).toBe(false);
    expect(running({ exitCode: null, signalCode: 'SIGKILL' })).toBe(false);
    expect(running(undefined)).toBe(false);
  });
});

describe('signalling a group qa started', () => {
  it('reaches the members that outlived their leader', { timeout: 15_000 }, async () => {
    // The leader starts a sleep in its own group and exits at once; once node has reaped it, the sleep is still there.
    const leader = spawn('/bin/sh', ['-c', '/bin/sleep 30 & echo $!'], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise((ok) => leader.once('exit', ok));   // listened for at once: it may exit before its line is read
    const member = pidFrom(await new Promise<string>((ok) => leader.stdout!.once('data', (b) => ok(String(b)))));
    onTestFinished(() => { signalGroup(leader.pid!, 'SIGKILL', leader); });
    expect(member).toBeGreaterThan(0);
    await exited;
    expect(alive(member!)).toBe(true);
    expect(signalGroup(leader.pid!, 'SIGKILL', leader)).toBe(true);
    expect(await until(() => !alive(member!), 5000)).toBe(true);
  });

  it('reaches a group whose leader is still running', { timeout: 15_000 }, async () => {
    const c = spawnDetached('/bin/sleep', ['30']);
    expect(signalGroup(c.pid!, 'SIGKILL', c)).toBe(true);
    expect(await until(() => c.exitCode !== null || c.signalCode !== null, 5000)).toBe(true);
  });
});
