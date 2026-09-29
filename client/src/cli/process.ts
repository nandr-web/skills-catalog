// The process commands: faces rather than operations, each running until it's stopped (the MCP server over stdio, the
// local web page's server). One table, beside the CLI's operation commands (run.ts's COMMANDS), so the words that name
// a command and the usage line see them all.
export const PROCESS_COMMANDS: Record<string, { flags: readonly string[] }> = {
  mcp: { flags: [] },
  serve: { flags: ['port', 'publish'] },
};
