// Identity, local adapter (contract §7): "act as" a developer, with no sign-in. The CLI and the MCP server pick the
// name (--as, SKILLS_AS, the server's config, or your name from setup). Locally this shows the owner rule; it isn't
// security: anyone on the machine can act as anyone.

import type { Identity } from '../ports.ts';

export function actAs(developer: string | undefined): Identity {
  return { actor: async () => developer };
}
