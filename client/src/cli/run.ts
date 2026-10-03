// The CLI face (contract §1, §3): the API's operations as commands, each in its own file (commands/), named as the
// words file's CLI names write them. run.ts reads a command line, checks it the same way for every command, and runs the
// operation through `perform`, so the words, the activity log and "(Acting as …)" are the same as on every face. Results
// go to stdout, errors to stderr. Exit 0 done, 1 an error, 3 needs the person.
//
// The read commands (search, read, versions, diff, list) open the catalog read-only (read-only.ts). A person-only flag
// (update's --accept) with no terminal does nothing and gives the person the command to run themselves (exit 3), a
// backstop only, since a command can fake a terminal: setup never pre-allows those commands, so an assistant running one
// meets the permission prompt.

import { parseArgs } from 'node:util';
import { CatalogError, Words, checkActor, renderError, shellQuote } from '@skills-catalog/core';
import { NAME_RE, flagText } from '@skills-catalog/core/skill-tree';
import { logWords } from '../activity.ts';
import { actingLine, contextFor, perform } from '../operations.ts';
import { settingsFrom } from '../settings.ts';
import { Usage, type Command, type Io, type Values } from './command.ts';
import { diff } from './commands/diff.ts';
import { install } from './commands/install.ts';
import { list } from './commands/list.ts';
import { policy } from './commands/policy.ts';
import { publish } from './commands/publish.ts';
import { read } from './commands/read.ts';
import { search } from './commands/search.ts';
import { review } from './commands/review.ts';
import { stats } from './commands/stats.ts';
import { logAccept, update } from './commands/update.ts';
import { versions } from './commands/versions.ts';
import { recordUsage } from '../usage/record.ts';
import { readOnlyContext } from './read-only.ts';
import { PROCESS_COMMANDS } from './process.ts';
import { cliWords } from './words.ts';
import { personView, usageLead } from '../person/view.ts';
import { terminal } from '../person/medium.ts';

export type { Io } from './command.ts';

/** The commands, keyed by the word after the command's name (as the words file's CLI names write it). */
export const COMMANDS: Record<string, Command> = { search, read, versions, diff, install, list, update, policy, stats, review, publish };

/** Every command word served: the operation commands and the process commands (process.ts). */
export const SERVED: readonly string[] = [...Object.keys(COMMANDS), ...Object.keys(PROCESS_COMMANDS)];

/** Every flag a command takes (no leading --): an operation command's with --as; a process command's own. */
export const flagsFor = (word: string): string[] =>
  Object.hasOwn(PROCESS_COMMANDS, word) ? [...PROCESS_COMMANDS[word]!.flags] : [...Object.keys(COMMANDS[word]?.flags ?? {}), 'as'];

/** The commands this CLI serves, as the words file names them, and the process commands (the MCP server, the page). */
export function usage(s: Words): string {
  const served = Object.values(s.names).filter((n) => Object.keys(COMMANDS).includes(n.split(' ')[1] ?? ''));
  const processes = Object.entries(PROCESS_COMMANDS).map(([word, p]) => [s.cli, word, ...(p.shown ?? p.flags).map((f) => (f === 'port' ? '[--port N]' : `[--${f}]`))].join(' '));
  return `${s.cli}\n${served.map((n) => `  ${n}`).join('\n')}\n${processes.map((n) => `  ${n}`).join('\n')}\n`;
}

/** What the CLI does, asked for (help, --help, -h, or nothing at all): each command with one line on what it's for,
 *  the process commands and sign-in too, on stdout (review V4.4). */
export function help(s: Words): string {
  const w = s.word('person.help') as { title: string; commands: Record<string, string>; footer: string };
  const lines = Object.entries(s.names)
    .filter(([, n]) => Object.keys(COMMANDS).includes(n.split(' ')[1] ?? ''))
    .map(([key, n]) => [n, w.commands[key] ?? '']);
  for (const word of [...Object.keys(PROCESS_COMMANDS), 'login', 'logout']) lines.push([`${s.cli} ${word}`, w.commands[word] ?? '']);
  const width = Math.max(...lines.map(([n]) => n!.length));
  return `${w.title}\n\n${lines.map(([n, what]) => `  ${n!.padEnd(width)}   ${what}`).join('\n')}\n\n${s.format(w.footer)}\n`;
}

/** A command line the CLI can't run as typed, as a person reads it: which part, why, and the command's own usage line;
 *  an assistant (no person at the terminal) keeps the error's words (review V4.2). */
function inputError(s: Words, io: Io, word: string, cmd: Command, e: CatalogError, withActing: (t: string) => string): string {
  if (!io.person || e.code !== 'invalid_request') return withActing(renderError(s, e));
  const d = e.data as { field?: string; why?: string };
  const raw = String(d.field ?? '');
  const field = raw.startsWith('-') || !Object.hasOwn(cmd.flags, raw) ? raw : `--${raw}`;
  const why = (s.word('errors.why') as Record<string, string>)[String(d.why)] ?? String(d.why ?? '');
  const own = Object.values(s.names).filter((n) => n.split(' ')[1] === word);
  const paint = terminal(io.color === true).paint;
  const lines = [`${paint('refused', '✗')} ${s.format(s.word('person.bad_input'), { field, why })}`, ...own.map((u) => paint('dim', `  ${s.format(s.word('person.bad_input_usage'), { usage: u })}`))];
  return withActing(lines.join('\n'));
}

// The command line as the person would type it, without the developer to act as (they are that developer).
const withoutAs = (argv: readonly string[]) => argv.filter((a, i) => !(a === '--as' || a.startsWith('--as=') || argv[i - 1] === '--as'));

export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const s = cliWords(Words.load());
  // A person who typed something the CLI doesn't take is told so before the list of what it takes.
  const showUsage = () => io.stderr((io.person ? usageLead(s) + '\n' : '') + usage(s));
  const [word, ...rest] = argv;
  if (word === undefined || word === 'help' || word === '--help' || word === '-h') {
    io.stdout(help(s));
    return 0;
  }
  const cmd = word === undefined || !Object.hasOwn(COMMANDS, word) ? undefined : COMMANDS[word];
  if (!cmd) {
    showUsage();
    return 1;
  }
  let values: Values;
  let words: string[];
  try {
    const options = Object.fromEntries(Object.entries({ as: { type: 'string' as const }, ...cmd.flags }).map(([k, f]) => [k, { type: f.type, ...('multiple' in f && f.multiple ? { multiple: true } : {}) }]));
    ({ values, positionals: words } = parseArgs({ args: [...rest], allowPositionals: true, strict: true, options }) as { values: Values; positionals: string[] });
  } catch {
    showUsage();
    return 1;
  }

  // --as: the developer to act as, checked here so a bad one names the flag.
  let developer: string | undefined;
  if (values['as'] !== undefined) {
    try {
      developer = checkActor(values['as']);
    } catch (e) {
      io.stderr(inputError(s, io, word, cmd, e as CatalogError, (t) => t) + '\n');
      return 1;
    }
  }
  const settings = settingsFrom({ ...io.env, ...(developer ? { SKILLS_AS: developer } : {}) }, io.cwd);
  const acting = actingLine(s, settings);
  const withActing = (text: string) => (acting ? `${text}\n${acting}` : text);

  let input: Record<string, unknown>;
  try {
    input = cmd.input(words, values);
  } catch (e) {
    if (e instanceof Usage) {
      showUsage();
      return 1;
    }
    io.stderr(inputError(s, io, word, cmd, e as CatalogError, withActing) + '\n');
    return 1;
  }

  // A person-only step with no terminal: nothing is done, and the person gets the command to run themselves, each word
  // shell-quoted after any control or invisible character in it is shown escaped (it reaches the person's terminal).
  const personOnly = cmd.personOnly?.find((f) => values[f] !== undefined && values[f] !== false);
  if (personOnly && !io.tty) {
    const command = [s.cli, ...withoutAs(argv).map((a) => shellQuote(flagText(a)))].join(' ');
    io.stderr(withActing(s.format(s.word('errors.person_only'), { command })) + '\n');
    // The activity log shows the step waiting for the person; its target only when it's a skill's name (the log holds
    // names and versions only, never text someone typed).
    const name = words.length === 1 && NAME_RE.test(words[0]!) ? words[0]! : '-';
    logAccept(settings, s, name, logWords(s).error('person_only'));
    recordUsage(settings.home, { event: 'use', op: cmd.personOnlyOp ?? cmd.op, result: 'person_only' });
    return 3;
  }

  const { ctx, close } = cmd.readOnly ? readOnlyContext(settings, s) : contextFor(settings, s, 'cli');
  try {
    const own = cmd.run?.({ ctx, s, io, words, values, input, withActing });
    if (own) return await own;
    const a = await perform(ctx, cmd.op, word!, input);
    const failed = a.isError || (cmd.failsOn?.includes(a.outcome) ?? false);
    // A person reads the result laid out for them, where this command has a view; otherwise its words.
    // A field the command line got wrong (a flag missing, a value not allowed) reads like any other typing mistake.
    const typed = io.person && a.isError && a.error instanceof CatalogError && a.error.code === 'invalid_request' && !String(a.error.data['why'] ?? '').includes('confirm') && a.error.data['field'] !== 'catalog';
    if (typed) {
      io.stderr(inputError(s, io, word!, cmd, a.error as CatalogError, withActing) + '\n');
      return 1;
    }
    const shown = io.person ? personView(s, terminal(io.color === true), cmd.op, a, input) : undefined;
    (failed ? io.stderr : io.stdout)((shown === undefined ? a.text : withActing(shown)) + '\n');
    return failed ? 1 : cmd.needsPersonOn?.includes(a.outcome ?? '') ? 3 : 0;
  } catch (e) {
    if (!(e instanceof Usage)) throw e;
    showUsage();
    return 1;
  } finally {
    close();
  }
}
