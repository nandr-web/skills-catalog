// The lock file around every change to lock.json (contract §4.5, "One writer at a time"): a stale one is taken, a live one
// waited for, then lock_busy. Two real processes at once: lock-race-processes.test.ts (slow).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, Words, actAs } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { holdLock, withLock } from '../src/machine/lock.ts';
import { contextFor, type Context } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

// The lock file names its holder: its process id and when that process started. A holder that's gone, or a process id now
// used by a process started at another time, leaves a stale lock, which the next run removes and takes. A live holder is
// waited for up to 5 seconds, then the run refuses with lock_busy {path, pid}, changing nothing (contract §4.5).
describe('the lock file', () => {
  const S = Words.load();
  const install = MACHINE_RUNS['install_shared_skill']!;
  const ctxFor = (p: Place, now?: () => Date): Context => {
    const { ctx } = contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project')), S, 'mcp');
    return now ? { ...ctx, now } : ctx;
  };
  const lockPath = (p: Place) => join(p.home, 'lock.json.lock');
  const hold = (p: Place, pid: number, started: number) => {
    mkdirSync(p.home, { recursive: true, mode: 0o700 });
    writeFileSync(lockPath(p), JSON.stringify({ pid, started }), { mode: 0o600 });
  };
  async function published(name: string): Promise<Place> {
    const p = place();
    const c = await open(p);
    try {
      await c.publish(request(name, [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`) }]), actAs('ana'));
    } finally {
      c.close();
    }
    return p;
  }
  // This process's own start, as the installer records it for a holder.
  const startedHere = Date.now() - Math.round(process.uptime() * 1000);

  it('left by a process that is gone: removed, taken, and the install goes through', async () => {
    const p = await published('alpha');
    const gone = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    hold(p, Number(gone.stdout), startedHere);
    expect((await install(ctxFor(p), { name: 'alpha' })).outcome).toBe('installed');
    expect(existsSync(lockPath(p))).toBe(false);
  });

  it('whose process id now belongs to a process started at another time: stale too', async () => {
    const p = await published('alpha');
    hold(p, process.pid, startedHere - 3_600_000);
    expect((await install(ctxFor(p), { name: 'alpha' })).outcome).toBe('installed');
    expect(existsSync(lockPath(p))).toBe(false);
  });

  it('checks a holder with the system\'s own ps, never one found on PATH', async () => {
    const p = await published('alpha');
    const bin = join(p.dir, 'bin');
    const marker = join(p.dir, 'fake-ps-ran');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'ps'), `#!/bin/sh\ntouch '${marker}'\necho 00:01\n`, { mode: 0o755 });
    hold(p, process.pid, startedHere - 3_600_000);
    const before = process.env['PATH'];
    process.env['PATH'] = `${bin}:${before ?? '/usr/bin:/bin'}`;
    try {
      expect((await install(ctxFor(p), { name: 'alpha' })).outcome).toBe('installed');
    } finally {
      process.env['PATH'] = before;
    }
    expect(existsSync(marker), 'a ps on PATH ran').toBe(false);
  });

  it('held by a live process: waited for up to 5 seconds, then lock_busy {path, pid}, and nothing changes', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    const started = Date.now();
    try {
      const p = await published('alpha');
      hold(p, child.pid!, started);
      // A clock that moves a second each time it's read, so the wait ends at once.
      let t = Date.parse('2026-09-29T12:00:00Z');
      const e = await install(ctxFor(p, () => new Date((t += 1000))), { name: 'alpha' }).catch((x: unknown) => x);
      expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['lock_busy', { path: lockPath(p), pid: child.pid }]);
      expect(existsSync(join(p.osHome, '.claude', 'skills', 'alpha'))).toBe(false);
      expect(existsSync(join(p.home, 'lock.json'))).toBe(false);
      expect(JSON.parse(readFileSync(lockPath(p), 'utf8'))).toEqual({ pid: child.pid, started });
    } finally {
      child.kill();
    }
  });

  // A lock naming this process that no hold of this process has is one it left behind (a pid reused after a crash), and
  // stale.
  it('naming this very process, started when it was: left behind, taken', async () => {
    const p = await published('alpha');
    hold(p, process.pid, startedHere);
    expect((await install(ctxFor(p), { name: 'alpha' })).outcome).toBe('installed');
    expect(existsSync(lockPath(p))).toBe(false);
  });

  // A holder this user can't signal (another user's process, here root's pid 1) is alive all the same: waited for, never
  // taken as stale, while its start matches.
  it.skipIf(process.getuid?.() === 0)('held by another user\'s live process: waited for, then lock_busy', async () => {
    const etime = spawnSync('ps', ['-o', 'etime=', '-p', '1'], { encoding: 'utf8' }).stdout.trim();
    const [s = 0, m = 0, h = 0, d = 0] = etime.split(/[-:]/).map(Number).reverse();
    const started = Date.now() - (((d * 24 + h) * 60 + m) * 60 + s) * 1000;
    const p = await published('alpha');
    hold(p, 1, started);
    let t = Date.parse('2026-09-29T12:00:00Z');
    const e = await install(ctxFor(p, () => new Date((t += 1000))), { name: 'alpha' }).catch((x: unknown) => x);
    expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['lock_busy', { path: lockPath(p), pid: 1 }]);
    expect(existsSync(join(p.osHome, '.claude', 'skills', 'alpha'))).toBe(false);
  });

  // The MCP server answers other calls while one waits for the lock: the wait never blocks the event loop.
  it('a run waiting for the lock leaves the event loop free', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    let ticks = 0;
    const tick = setInterval(() => ticks++, 5);
    try {
      const p = await published('alpha');
      hold(p, child.pid!, Date.now());
      // A clock that moves 400 ms each time it's read: about a dozen waits before lock_busy.
      let t = Date.parse('2026-09-29T12:00:00Z');
      const e = await install(ctxFor(p, () => new Date((t += 400))), { name: 'alpha' }).catch((x: unknown) => x);
      expect((e as CatalogError).code).toBe('lock_busy');
      expect(ticks).toBeGreaterThan(3);
    } finally {
      clearInterval(tick);
      child.kill();
    }
  });

  // A holder's start, as the system reports it, is compared without a time zone: whatever TZ this run has, a live holder
  // is never taken for a stale one (two runs would then write at once).
  it('held by a live process in any time zone: still waited for, then lock_busy', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
    const started = Date.now();
    const tz = process.env['TZ'];
    try {
      for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'UTC']) {
        process.env['TZ'] = zone;
        const p = await published('alpha');
        hold(p, child.pid!, started);
        let t = Date.parse('2026-09-29T12:00:00Z');
        const e = await install(ctxFor(p, () => new Date((t += 1000))), { name: 'alpha' }).catch((x: unknown) => x);
        expect([zone, (e as CatalogError).code]).toEqual([zone, 'lock_busy']);
        expect([zone, existsSync(join(p.osHome, '.claude', 'skills', 'alpha'))]).toEqual([zone, false]);
      }
    } finally {
      if (tz === undefined) delete process.env['TZ'];
      else process.env['TZ'] = tz;
      child.kill();
    }
  });
});

// Two calls of one process (an install while an update holds the lock, in one MCP server) take turns like two runs: the
// second waits for the first's release, then takes the lock itself, and the file stays while either holds it.
describe('the lock file, between calls of one process', () => {
  const home = () => {
    const p = place();
    mkdirSync(p.home, { recursive: true, mode: 0o700 });
    return p.home;
  };
  const lockPath = (h: string) => join(h, 'lock.json.lock');
  const holder = (h: string) => JSON.parse(readFileSync(lockPath(h), 'utf8')) as { pid: number };
  const settle = () => new Promise((done) => setTimeout(done, 150));

  it('a second call starting while the first is taking the lock waits for it, and never takes the first\'s file for a leftover', async () => {
    const h = home();
    const first = holdLock(h, Date.now);
    const second = holdLock(h, Date.now);
    const one = first.change(() => 1);
    let secondDone = false;
    const two = second.change(() => 2).then((x) => ((secondDone = true), x));
    await one;
    const firstFile = statSync(lockPath(h)).ino;
    await settle();
    expect(secondDone).toBe(false);
    expect(statSync(lockPath(h)).ino).toBe(firstFile);
    first.release();
    expect(await two).toBe(2);
    expect(holder(h).pid).toBe(process.pid);
    second.release();
    expect(existsSync(lockPath(h))).toBe(false);
  });

  it('a call that starts while another holds the lock waits for its release, so the file stays until the last hold ends', async () => {
    const h = home();
    const update = holdLock(h, Date.now);
    await update.change(() => undefined);
    const install = holdLock(h, Date.now);
    let installed = false;
    const done = install.change(() => (installed = true));
    await settle();
    expect(installed).toBe(false);
    update.release();
    await done;
    expect(installed).toBe(true);
    expect(existsSync(lockPath(h))).toBe(true);
    install.release();
    expect(existsSync(lockPath(h))).toBe(false);
  });

  it('a call still waiting when the 5 seconds are up refuses with lock_busy naming this process, and the holder keeps the lock', async () => {
    const h = home();
    const update = holdLock(h, Date.now);
    await update.change(() => undefined);
    // A clock that moves a second each time it's read, so the wait ends at once.
    let t = Date.parse('2026-09-29T12:00:00Z');
    const e = await withLock(h, () => (t += 1000), () => undefined).catch((x: unknown) => x);
    expect([(e as CatalogError).code, (e as CatalogError).data]).toEqual(['lock_busy', { path: lockPath(h), pid: process.pid }]);
    expect(holder(h).pid).toBe(process.pid);
    update.release();
    expect(existsSync(lockPath(h))).toBe(false);
  });
});
