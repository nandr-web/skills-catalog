#!/usr/bin/env node
// skills-catalog on this machine. `skills-catalog mcp` serves the catalog's tools to an assistant over stdio (the MCP
// server an assistant's config starts); `skills-catalog serve` serves the local web page until it's stopped
// (cli/serve.ts); every other command is the CLI face (cli/run.ts). Exit codes: 0 done, 1 an error, 3 needs the person
// or answers (contract §1).
// The body is main.ts, imported only after quiet-warnings.ts: node:sqlite warns as it loads, and a static import would
// load it before any code here runs.
import './quiet-warnings.ts';
await import('./main.ts');
