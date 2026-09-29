#!/usr/bin/env node
// skills-catalog on this machine. `skills-catalog mcp` serves the catalog's tools to an assistant over stdio (the MCP
// server an assistant's config starts); the CLI's own commands (publish, install, update, setup, …) join with the
// installer. Exit codes: 0 done, 1 an error, 3 needs answers (contract §1).
import { readFileSync } from 'node:fs';
import { serveStdio } from './mcp/server.ts';
import { settingsFrom } from './settings.ts';

const USAGE = `skills-catalog: your team's shared skills catalog, on this machine

  skills-catalog mcp
      Serves the catalog's tools to an assistant over stdio (MCP). Settings come from the environment: SKILLS_HOME,
      SKILLS_CATALOG, SKILLS_AS (the developer you act as locally, for demo purposes), SKILLS_ACTIVITY_LOG.
`;

const [command, ...rest] = process.argv.slice(2);
if (command === 'mcp' && rest.length === 0) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  await serveStdio({ settings: settingsFrom(process.env), version });
} else {
  process.stderr.write(USAGE);
  process.exitCode = 1;
}
