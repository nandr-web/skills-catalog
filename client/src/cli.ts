#!/usr/bin/env node
// skills-catalog on this machine. `skills-catalog mcp` serves the catalog's tools to an assistant over stdio (the MCP
// server an assistant's config starts); `skills-catalog serve` serves the local web page until it's stopped
// (cli/serve.ts); every other command is the CLI face (cli/run.ts). Exit codes: 0 done, 1 an error, 3 needs the person
// or answers (contract §1).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Words } from '@skills-catalog/core';
import { runCli, usage } from './cli/run.ts';
import { runServe } from './cli/serve.ts';
import { cliWords } from './cli/words.ts';
import { serveStdio } from './mcp/server.ts';
import { settingsFrom } from './settings.ts';

const USAGE = `skills-catalog: your team's shared skills catalog, on this machine

  skills-catalog mcp
      Serves the catalog's tools to an assistant over stdio (MCP). Settings come from the environment: SKILLS_HOME,
      SKILLS_CATALOG, SKILLS_AS (the developer you act as locally, for demo purposes), SKILLS_ACTIVITY_LOG.
`;

const [command, ...rest] = process.argv.slice(2);
// One terminal check, for every command that asks the person something or refuses without them.
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
if (command === 'mcp' && rest.length === 0) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  await serveStdio({ settings: settingsFrom(process.env), version });
} else if (command === 'mcp') {
  process.stderr.write(USAGE);
  process.exitCode = 1;
} else if (command === 'serve') {
  // Runs until the person stops it (Ctrl-C) or the process is told to end.
  const stopped = new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  const s = cliWords(Words.load());
  const io = { env: process.env, cwd: process.cwd(), tty, stdout: (t: string) => void process.stdout.write(t), stderr: (t: string) => void process.stderr.write(t), stopped };
  process.exitCode = await runServe(rest, s, io, usage(s));
} else {
  // Every other command is the CLI face; a person at a terminal answers its questions here.
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    cwd: process.cwd(),
    tty,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
  });
}
