// The CLI's body, loaded by cli.ts once Node's SQLite warning is quieted (quiet-warnings.ts).
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Words } from '@skills-catalog/core';
import { runCli, usage } from './cli/run.ts';
import { runLogin, runLogout } from './cli/login.ts';
import { runServe } from './cli/serve.ts';
import { cliWords } from './cli/words.ts';
import { serveStdio } from './mcp/server.ts';
import { settingsFrom } from './settings.ts';
import { wantsColor } from './person/terminal.ts';

const USAGE = `skills-catalog: your team's shared skills catalog, on this machine

  skills-catalog mcp
      Serves the catalog's tools to an assistant over stdio (MCP). Settings come from the environment: SKILLS_HOME,
      SKILLS_CATALOG, SKILLS_AS (the developer you act as locally, for demo purposes), SKILLS_ACTIVITY_LOG.
  skills-catalog login [--scope publish|read] [--client-id <id>] | login --with-token < token
      Signs in to a hosted catalog (SKILLS_CATALOG=https://…) with GitHub and saves its token in $SKILLS_HOME/token.
  skills-catalog logout
      Deletes the saved token.
`;

const [command, ...rest] = process.argv.slice(2);

/** One question to the person at the terminal; Ctrl-D or Ctrl-C at it is an empty answer (a no), not a crash. */
async function askPerson(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
    process.stdout.write('\n');
    return '';
  } finally {
    rl.close();
  }
}
// One terminal check, for every command that asks the person something or refuses without them.
const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
if (command === 'mcp' && rest.length === 0) {
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  await serveStdio({ settings: settingsFrom(process.env), version });
} else if (command === 'mcp') {
  process.stderr.write(USAGE);
  process.exitCode = 1;
} else if (command === 'login') {
  const readStdin = async () => {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  };
  process.exitCode = await runLogin(rest, { settings: settingsFrom(process.env), env: process.env, stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t), readStdin });
} else if (command === 'hook') {
  // Setup's session-start hook: always exit 0, and once its 2 seconds are up, don't wait for a sync still running (the
  // next session start or the MCP server's start finishes it).
  const { runHook } = await import('./cli/hook.ts');
  await runHook(rest, cliWords(Words.load()), { env: process.env, cwd: process.cwd(), stdin: process.stdin, stdout: (t) => void process.stdout.write(t) });
  process.stdout.write('', () => process.exit(0));
} else if (command === 'setup') {
  const { runSetupCommand } = await import('./cli/setup.ts');
  process.exitCode = await runSetupCommand(rest, { env: process.env, cwd: process.cwd(), tty, color: wantsColor(Boolean(process.stdout.isTTY), process.env), ask: askPerson, stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) });
} else if (command === 'teardown') {
  const { runTeardownCommand } = await import('./cli/teardown.ts');
  process.exitCode = await runTeardownCommand(rest, { env: process.env, cwd: process.cwd(), color: wantsColor(Boolean(process.stdout.isTTY), process.env), stdout: (t) => void process.stdout.write(t), stderr: (t) => void process.stderr.write(t) });
} else if (command === 'logout') {
  process.exitCode = runLogout({ settings: settingsFrom(process.env), stdout: (t) => void process.stdout.write(t) });
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
    // A person reads stdout: results are laid out for them, in colour unless NO_COLOR is set.
    person: Boolean(process.stdout.isTTY),
    color: wantsColor(Boolean(process.stdout.isTTY), process.env),
    ask: askPerson,
    stdout: (t) => void process.stdout.write(t),
    stderr: (t) => void process.stderr.write(t),
  });
}
