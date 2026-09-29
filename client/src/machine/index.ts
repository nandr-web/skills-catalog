// The machine operations (contract §3): install, update, list installed, set policy, accept a held update, publish a
// folder. They run on this machine, with the same context as the catalog's operations (operations.ts), keyed by the
// registry's operation name, so every face (MCP, CLI) picks them up from one place. Filled by the installer.
// Import only types from operations.ts here: it imports this file, so a value imported back would be read too early.
import type { Run } from '../operations.ts';
import { publishFolder } from './publish-folder.ts';
import { accept, install, list, setPolicy, update } from './installer.ts';

export const MACHINE_RUNS: Record<string, Run> = {
  publish_skill_to_catalog: publishFolder,
  install_shared_skill: install,
  update_installed_skills: update,
  accept_held_update: accept,
  list_installed_skills: list,
  set_skill_update_policy: setPolicy,
};
