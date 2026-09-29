// One hosted run at a time on a machine: the stand-in closes every connection, so a run leaves thousands of local ports
// waiting to close, and two runs at once can use up the machine's ephemeral ports. A run holds a fixed 127.0.0.1 port
// (the kernel frees it when the process ends, so no lock is ever left behind), and starts only once the ports waiting
// to close are few.

import { describe, expect, it } from 'vitest';
import { takeRunLock, waitForFreePorts } from './run-lock.ts';

// Not the real lock's port: these tests run inside a run that holds it.
const PORT = 47_391;

describe('the run lock', () => {
  it('a second taker waits while the first holds it, and gets it once the first lets go', async () => {
    const first = await takeRunLock({ port: PORT, timeoutMs: 1000, pollMs: 20 });
    let second: { release(): Promise<void> } | undefined;
    const waiting = takeRunLock({ port: PORT, timeoutMs: 2000, pollMs: 20 }).then((l) => (second = l));
    await new Promise((r) => setTimeout(r, 150));
    expect(second).toBeUndefined();
    await first.release();
    await waiting;
    expect(second).toBeDefined();
    await second!.release();
  });

  it('gives up after its timeout with a message that says what holds it', async () => {
    const held = await takeRunLock({ port: PORT, timeoutMs: 1000, pollMs: 20 });
    try {
      await expect(takeRunLock({ port: PORT, timeoutMs: 200, pollMs: 20 })).rejects.toThrow(/another hosted test run.*127\.0\.0\.1:47391/);
    } finally {
      await held.release();
    }
  });
});

describe('waiting for free ports', () => {
  it('goes on at once when few ports are waiting to close', async () => {
    const seen: number[] = [];
    await waitForFreePorts({ count: async () => (seen.push(10), 10), limit: 4000, timeoutMs: 100, pollMs: 10 });
    expect(seen).toEqual([10]);
  });

  it('waits while too many are, and goes on once they drain', async () => {
    const counts = [9000, 6000, 3999];
    const seen: number[] = [];
    await waitForFreePorts({ count: async () => { const c = counts.shift() ?? 0; seen.push(c); return c; }, limit: 4000, timeoutMs: 1000, pollMs: 10 });
    expect(seen).toEqual([9000, 6000, 3999]);
  });

  it('gives up after its timeout, saying how many are waiting', async () => {
    await expect(waitForFreePorts({ count: async () => 9000, limit: 4000, timeoutMs: 50, pollMs: 10 })).rejects.toThrow(/9000 local ports.*4000/);
  });

  it('a machine where the count cannot be read goes on (the lock still holds)', async () => {
    await waitForFreePorts({ count: async () => undefined, limit: 4000, timeoutMs: 50, pollMs: 10 });
  });
});
