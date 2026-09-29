// Two installer processes at once (contract §4.5, "One writer at a time"): each reads the lock, installs, and writes the
// lock back, so without a lock around that, one run's entry can be lost when the other writes (7 of 20 were, before it).
// Real processes, as a session-start sync and a person's command would run them. A slow file (test/slow.json).
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { actAs } from '@skills-catalog/core';
import { refuseRealPlaces } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { readLock } from '../src/machine/lock.ts';
import { open, request, skillMd } from './seed.ts';
import { PROCESS_TEST_MS, place } from './server.ts';

const bin = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ROUNDS = 10;

describe('two installer processes at once', () => {
  it(`keep every lock entry (${ROUNDS} rounds of two installs started together)`, async () => {
    const p = place();
    const names = Array.from({ length: ROUNDS }, (_, i) => [`round${i}-a`, `round${i}-b`] as const);
    const c = await open(p);
    try {
      for (const name of names.flat()) await c.publish(request(name, [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`) }]), actAs('ana'));
    } finally {
      c.close();
    }
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: p.osHome, SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed };
    for (const v of [env.HOME, env.SKILLS_HOME]) refuseRealPlaces(v);
    const run = (name: string) =>
      new Promise<{ code: number | null; err: string }>((resolve) => {
        const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', bin, 'install', name], { env, cwd: p.dir, stdio: ['ignore', 'ignore', 'pipe'] });
        let err = '';
        child.stderr.on('data', (d: Buffer) => (err += d.toString()));
        child.on('close', (code) => resolve({ code, err }));
      });
    for (const pair of names) {
      const results = await Promise.all(pair.map(run));
      expect(results.map((r) => [r.code, r.err])).toEqual([[0, ''], [0, '']]);
    }
    const installed = Object.values(readLock(p.home).skills).map((e) => e.name).sort();
    expect(installed).toEqual(names.flat().sort());
  }, PROCESS_TEST_MS * 4);
});
