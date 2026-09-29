// qa keeps its own descriptor on the run's marker until the leftovers are stopped (marker.ts), and closes it however
// the run ends: here teardown itself fails. A file of its own, since teardown is replaced for every test in it.
import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { qaRun } from '../src/run.ts';
import { cleanup, machine, PROCESS_TEST_MS } from './machine.ts';

vi.mock('../src/teardown.ts', async (original) => ({ ...(await original<typeof import('../src/teardown.ts')>()), teardown: async () => { throw new Error('teardown failed'); } }));
vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // starts a process and runs the before/after check

afterEach(cleanup);

// This process's open descriptors (macOS and Linux both list them in /dev/fd)
const open = () => readdirSync('/dev/fd').length;

describe('qa\'s own descriptor on the marker', () => {
  it('is closed when teardown fails', async () => {
    const m = machine();
    const before = open();
    await expect(qaRun({ machine: m, command: ['/usr/bin/true'] })).rejects.toThrow('teardown failed');
    expect(open()).toBe(before);
  });
});
