// The core's shared suites (storage, the catalog's oracles, the discovery golden set) on the hosted adapters, against the
// stand-in: the same tests and oracles as the local adapters.

import { afterAll, beforeAll } from 'vitest';
import { catalogSuite, discoverySuite, storageSuite } from '@skills-catalog/core/testing/suites';
import { hostedAdapter } from './adapter.ts';
import { startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

const hosted = hostedAdapter(() => emu!.endpoint);
storageSuite(hosted);
catalogSuite(hosted);
discoverySuite(hosted);
