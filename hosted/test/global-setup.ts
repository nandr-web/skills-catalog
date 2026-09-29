// Once per run, in vitest's main process: take the machine-wide run lock (test/run-lock.ts), then wait for the ports the
// last run left waiting to close. Held until the run ends.

import { takeRunLock, waitForFreePorts } from './run-lock.ts';

export default async function setup(): Promise<() => Promise<void>> {
  const lock = await takeRunLock({ timeoutMs: 15 * 60_000 });
  try {
    await waitForFreePorts({ timeoutMs: 3 * 60_000 });
  } catch (e) {
    await lock.release();
    throw e;
  }
  return () => lock.release();
}
