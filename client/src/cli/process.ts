// The process commands: faces rather than operations, each running until it's stopped (the MCP server over stdio, the
// local web page's server). One table, beside the CLI's operation commands (run.ts's COMMANDS), so the words that name
// a command and the usage line see them all.
// Setup, teardown and sign-in run once and end, but like these they're processes of their own rather than operations
// (main.ts runs them); listed here so the words that name them, and the flags those words name, are checked too.
// `shown`: the flags the usage line names, when not all of them.
export const PROCESS_COMMANDS: Record<string, { flags: readonly string[]; shown?: readonly string[] }> = {
  mcp: { flags: [] },
  serve: { flags: ['port', 'publish'] },
  setup: { flags: ['yes', 'config', 'dry-run', 'print-mcp-entry', 'help', 'auto-update', 'catalog', 'for', 'me', 'demo-developers', 'no-demo-developers', 'terminal-command'], shown: ['yes', 'config', 'dry-run'] },
  teardown: { flags: [] },
  login: { flags: ['scope', 'client-id', 'with-token'], shown: [] },
  logout: { flags: [] },
};
