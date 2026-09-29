// The lock file's guards under faults a real run meets rarely (contract §4.5, "One writer at a time"): a write that fails,
// another user's file, a file changed between the look and the removal, and the clock a holder's start is read on.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogError } from '@skills-catalog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdLock, startFromEtime, withLock } from '../src/machine/lock.ts';
import { race } from './race-fs.ts';
import { place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
// `ps` says this process started three days ago (a server running since before the laptop slept); any other pid is asked
// for real.
const THREE_DAYS_MS = 3 * 24 * 3600 * 1000;
vi.mock('node:child_process', async (o) => {
  const real = await o<typeof import('node:child_process')>();
  const spawnSync = ((cmd: string, args: readonly string[], opts: object) =>
    cmd === 'ps' && args.at(-1) === String(process.pid) ? { stdout: '3-00:00:00\n', stderr: '', status: 0 } : real.spawnSync(cmd, args, opts)) as typeof real.spawnSync;
  return { ...real, spawnSync, default: { ...real, spawnSync } };
});

const home = () => {
  const p = place();
  mkdirSync(p.home, { recursive: true, mode: 0o700 });
  return p.home;
};
const lockPath = (h: string) => join(h, 'lock.json.lock');
const deadPid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
// A clock that moves a second each time it's read, so a wait ends at once.
const fast = () => {
  let t = Date.parse('2026-09-29T12:00:00Z');
  return () => (t += 1000);
};

afterEach(() => {
  race.onWrite = undefined;
  race.stats = undefined;
});

describe('the lock file under faults', () => {
  it('a lock file whose holder couldn\'t be written is removed, not left empty for the next run to wait on', async () => {
    const h = home();
    race.onWrite = () => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
    await expect(withLock(h, Date.now, () => undefined)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(existsSync(lockPath(h))).toBe(false);
    race.onWrite = undefined;
    // The next run takes it at once, not after the 5 seconds an unreadable holder costs.
    expect(await withLock(h, fast(), () => 'taken')).toBe('taken');
  });

  it('a stale lock file owned by another user is never removed: lock_busy with no pid (its sentence names the file), and it stays', async () => {
    const h = home();
    const pid = deadPid();
    writeFileSync(lockPath(h), JSON.stringify({ pid, started: Date.now() }), { mode: 0o600 });
    race.stats = (path) => (path === lockPath(h) ? { uid: (process.getuid?.() ?? 0) + 1 } : undefined);
    const e = await withLock(h, fast(), () => undefined).catch((x: unknown) => x);
    expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['lock_busy', { path: lockPath(h), pid: null }]);
    expect(existsSync(lockPath(h))).toBe(true);
  });

  // Gone at every look and back at every try to make it: the wait still ends at its 5 seconds, never spinning.
  it('a lock file that vanishes at each look and is back at each try: lock_busy when the wait is up', async () => {
    const h = home();
    const text = JSON.stringify({ pid: deadPid(), started: Date.now() });
    race.onOpen = (path, flags) => {
      if (path === lockPath(h) && flags === 'wx') race.fs.writeFileSync(path, text);
    };
    race.onLstat = (path) => {
      if (path === lockPath(h)) race.fs.rmSync(path, { force: true });
    };
    try {
      const e = await withLock(h, fast(), () => undefined).catch((x: unknown) => x);
      expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['lock_busy', { path: lockPath(h), pid: null }]);
    } finally {
      race.onOpen = undefined;
      race.onLstat = undefined;
    }
  }, 3000);

  it('a stale lock file changed between the look and the removal (a new change time, the same text) is treated as held', async () => {
    const h = home();
    const pid = deadPid();
    writeFileSync(lockPath(h), JSON.stringify({ pid, started: Date.now() }), { mode: 0o600 });
    // Every look sees a later change time than the one before, as a file touched in between would show.
    let looks = 0;
    race.stats = (path, s) => (path === lockPath(h) ? { ctimeMs: s.ctimeMs + ++looks } : undefined);
    const e = await withLock(h, fast(), () => undefined).catch((x: unknown) => x);
    expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['lock_busy', { path: lockPath(h), pid }]);
    expect(existsSync(lockPath(h))).toBe(true);
  });

  it('records this process\'s start as `ps` reports it, the clock another run compares it on', async () => {
    const h = home();
    let started: number | undefined;
    await withLock(h, Date.now, () => {
      started = (JSON.parse(readFileSync(lockPath(h), 'utf8')) as { started: number }).started;
    });
    expect(Math.abs(Date.now() - THREE_DAYS_MS - started!)).toBeLessThan(5000);
  });
});

describe('what the lock leaves as it is', () => {
  it('a change that changes nothing (a hold) leaves lock.json as it is: the same file, the same bytes', async () => {
    const h = home();
    const file = join(h, 'lock.json');
    writeFileSync(file, '{\n  "skills": {}\n}\n', { mode: 0o600 });
    const [ino, bytes] = [race.fs.statSync(file).ino, readFileSync(file, 'utf8')];
    await withLock(h, Date.now, () => undefined);
    expect([race.fs.statSync(file).ino, readFileSync(file, 'utf8')]).toEqual([ino, bytes]);
  });

  it('a release after the lock file was replaced leaves the new file: it isn\'t this hold\'s any more', async () => {
    const h = home();
    const hold = holdLock(h, Date.now);
    await hold.change(() => undefined);
    const other = JSON.stringify({ pid: deadPid(), started: Date.now() });
    race.fs.rmSync(lockPath(h));
    writeFileSync(lockPath(h), other, { mode: 0o600 });
    hold.release();
    expect(readFileSync(lockPath(h), 'utf8')).toBe(other);
  });

  it('a holder write that fails after the lock file was swapped leaves the swapped-in file', async () => {
    const h = home();
    const other = JSON.stringify({ pid: deadPid(), started: Date.now() });
    race.onWrite = () => {
      race.onWrite = undefined;
      race.fs.rmSync(lockPath(h));
      race.fs.writeFileSync(lockPath(h), other, { mode: 0o600 });
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    };
    await expect(withLock(h, Date.now, () => undefined)).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(readFileSync(lockPath(h), 'utf8')).toBe(other);
  });
});

describe('a start from ps etime', () => {
  const now = Date.parse('2026-09-29T12:00:00Z');
  it.each([
    ['3-04:05:06', ((3 * 24 + 4) * 3600 + 5 * 60 + 6) * 1000],
    ['04:05:06', (4 * 3600 + 5 * 60 + 6) * 1000],
    ['05:06', (5 * 60 + 6) * 1000],
    ['  12-00:00:01\n', (12 * 24 * 3600 + 1) * 1000],
  ])('%j is that long before now', (etime, ms) => {
    expect(startFromEtime(etime, now)).toBe(now - ms);
  });
  it.each(['', 'Thu Sep 29 12:00:00 2026', '1-2', '-01:02'])('%j is not a start', (etime) => {
    expect(startFromEtime(etime, now)).toBeUndefined();
  });
});
