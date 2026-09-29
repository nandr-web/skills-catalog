// The machine operations (contract §3): install, update, list installed, set policy, accept a held update, publish a
// folder. They run on this machine, with the same context as the catalog's operations (operations.ts). Each operation's
// row (the core's api.ts) names its function here by `run`; operations.ts looks it up through the row.
// Import only types from operations.ts here: it imports this file, so a value imported back would be read too early.
import { OPERATIONS } from '@skills-catalog/core';
import type { MachineRun } from '../operations.ts';
import { publishFolder } from './publish-folder.ts';
import { accept, install, list, setPolicy, update } from './installer.ts';

/** The machine's run functions, by the name a row gives in `run`. */
export const MACHINE: Record<string, MachineRun> = { publishFolder, install, update, accept, list, setPolicy };

/** The same functions by operation name, derived from the rows (never kept by hand): for tests that call one directly. */
export const MACHINE_RUNS: Record<string, MachineRun> = Object.fromEntries(
  Object.entries(OPERATIONS).flatMap(([op, row]) => (Object.hasOwn(MACHINE, row.run) ? [[op, MACHINE[row.run]!]] : [])),
);
