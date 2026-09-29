// The machine operations (contract §3): install, update, list installed, set policy, accept a held update, publish a
// folder. They run on this machine, with the same context as the catalog's operations (operations.ts), keyed by the
// registry's operation name, so every face (MCP, CLI) picks them up from one place. Filled by the installer.
// Import only types from operations.ts here: it imports this file, so a value imported back would be read too early.
import type { Run } from '../operations.ts';
import { publishFolder } from './publish-folder.ts';

export const MACHINE_RUNS: Record<string, Run> = {
  publish_skill_to_catalog: publishFolder,
};
