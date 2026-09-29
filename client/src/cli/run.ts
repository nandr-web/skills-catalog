// The CLI face (contract §1, §3), for now the installer's three commands: install, list, and update (with the gate's
// person-only --accept). Each runs the registry's operation through `perform`, so the words, the activity log and
// "(Acting as …)" are the same as on every face. Skill names are positional; every other input is --field-name
// (underscores as hyphens), and a list repeats its singular flag. Results go to stdout, errors to stderr. Exit 0 done,
// 1 an error, 3 needs the person.
//
// `update <name> --accept` asks in the person's own terminal and refuses without one (exit 3), a backstop only, since a
// command can fake a terminal. Setup never pre-allows it, so an assistant running it meets the permission prompt.

import { parseArgs } from 'node:util';
import { CatalogError, Surface, checkActor, inputSchema, renderError, shellQuote, toCatalogError } from '@skills-catalog/core';
import { NAME_RE } from '@skills-catalog/core/skill-tree';
import { appendActivity, logWords } from '../activity.ts';
import { actingAs, contextFor, perform, type Context } from '../operations.ts';
import { pendingHold } from '../machine/installer.ts';
import type { Target } from '../machine/lock.ts';
import { settingsFrom, type Settings } from '../settings.ts';
import { cliSurface } from './words.ts';

export type Io = {
  env: Record<string, string | undefined>;
  cwd: string;
  /** A person at a terminal can answer (stdin and stdout are both terminals). */
  tty: boolean;
  ask: (question: string) => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
};

// The commands, keyed by the word after the command's name (as the surface's CLI names write it), with the inputs their
// positionals fill: `names` takes any number of skill names.
type Command = { op: string; positional: 'names' | readonly string[] };
export const COMMANDS: Record<string, Command> = {
  install: { op: 'install_shared_skill', positional: ['name'] },
  list: { op: 'list_installed_skills', positional: [] },
  update: { op: 'update_installed_skills', positional: 'names' },
};

type Schema = { type?: string };
type Flag = { key: string; field: string; kind: 'boolean' | 'string' | 'integer' | 'list' };

const TARGETS: readonly string[] = ['user', 'project'];
const kebab = (s: string) => s.replaceAll('_', '-');
const singular = (s: string) => (s.endsWith('s') ? s.slice(0, -1) : s);

// Every input that isn't positional, as a flag.
function flagsOf(cmd: Command): Flag[] {
  const taken = new Set(cmd.positional === 'names' ? ['names'] : cmd.positional);
  return Object.entries((inputSchema(cmd.op, 'cli').properties ?? {}) as Record<string, Schema>)
    .filter(([k]) => !taken.has(k))
    .map(([k, v]) =>
      v.type === 'array'
        ? { key: kebab(singular(k)), field: k, kind: 'list' as const }
        : { key: kebab(k), field: k, kind: v.type === 'boolean' ? ('boolean' as const) : v.type === 'integer' ? ('integer' as const) : ('string' as const) },
    );
}

// A number where one is expected; anything else goes to the registry as typed, which refuses it in its own words.
const numberOr = (v: string): number | string => (/^-?\d+$/.test(v) ? Number(v) : v);

/** The commands this CLI serves, as the surface names them, and the MCP server. */
export function usage(s: Surface): string {
  const served = Object.values(s.names).filter((n) => Object.keys(COMMANDS).includes(n.split(' ')[1] ?? ''));
  return `${s.cli}\n${served.map((n) => `  ${n}`).join('\n')}\n  ${s.cli} mcp\n`;
}

export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  const s = cliSurface(Surface.load());
  const [word, ...rest] = argv;
  const cmd = word === undefined ? undefined : COMMANDS[word];
  if (!cmd) {
    io.stderr(usage(s));
    return 1;
  }
  const flags = flagsOf(cmd);
  const extra: Record<string, { type: 'string' | 'boolean' }> = { as: { type: 'string' } };
  if (word === 'update') Object.assign(extra, { accept: { type: 'boolean' }, target: { type: 'string' } });
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: { ...extra, ...Object.fromEntries(flags.map((f) => [f.key, { type: f.kind === 'boolean' ? ('boolean' as const) : ('string' as const), ...(f.kind === 'list' ? { multiple: true } : {}) }])) },
    });
  } catch {
    io.stderr(usage(s));
    return 1;
  }
  const values = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const positionals = parsed.positionals;
  // --target on update says where a held first install goes, so it goes only with --accept, as user or project.
  const target = values['target'];
  if (word === 'update' && target !== undefined && (values['accept'] !== true || typeof target !== 'string' || !TARGETS.includes(target))) {
    io.stderr(usage(s));
    return 1;
  }

  // --as: the developer to act as, checked here so a bad one names the flag.
  let developer: string | undefined;
  if (values['as'] !== undefined) {
    try {
      developer = checkActor(values['as']);
    } catch (e) {
      io.stderr(renderError(s, e as CatalogError) + '\n');
      return 1;
    }
  }
  const settings = settingsFrom({ ...io.env, ...(developer ? { SKILLS_AS: developer } : {}) }, io.cwd);
  const withActing = (text: string) => (settings.developer ? `${text}\n${actingAs(s, settings.developer)}` : text);

  // The inputs, from the positionals and the flags.
  const args: Record<string, unknown> = {};
  if (cmd.positional === 'names') {
    if (positionals.length) args['names'] = [...positionals];
  } else {
    if (positionals.length !== cmd.positional.length) {
      io.stderr(usage(s));
      return 1;
    }
    cmd.positional.forEach((k, i) => (args[k] = positionals[i]));
  }
  for (const f of flags) {
    const v = values[f.key];
    if (v !== undefined) args[f.field] = f.kind === 'integer' && typeof v === 'string' ? numberOr(v) : v;
  }

  // The person-only step: with no terminal, nothing is done and the person gets the command to run themselves.
  const accept = word === 'update' && values['accept'] === true;
  if (accept && !io.tty) {
    const command = [s.cli, ...argv.filter((a, i) => !(a === '--as' || a.startsWith('--as=') || argv[i - 1] === '--as')).map(shellQuote)].join(' ');
    io.stderr(withActing(s.format(s.word('errors.person_only'), { command })) + '\n');
    // The activity log shows the step waiting for the person; its target only when it's a skill's name (the log holds
    // names and versions only, never text someone typed).
    const name = positionals.length === 1 && NAME_RE.test(positionals[0]!) ? positionals[0]! : '-';
    logAccept(settings, s, name, logWords(s).error('person_only'));
    return 3;
  }

  const { ctx, close } = contextFor(settings, s, 'cli');
  try {
    if (accept) return await acceptHeld(ctx, s, io, positionals, (target as Target | undefined) ?? 'user', withActing);
    const a = await perform(ctx, cmd.op, word!, args);
    (a.isError ? io.stderr : io.stdout)(a.text + '\n');
    return a.isError ? 1 : 0;
  } finally {
    close();
  }
}

// The activity-log line for the parts of update --accept that no operation logs: refused without a terminal, and the
// person's no. The target is a skill's name (and version), never other text.
function logAccept(settings: Settings, s: Surface, target: string, result: string): void {
  const log = logWords(s);
  appendActivity(settings.activityLog, { at: new Date(), who: settings.developer, tool: 'update --accept', target, result }, { ownFolder: settings.activityLogInHome, resultWidth: log.width });
}

// Words the CLI waits for from the surface (the --accept words); until they're vendored each shows as its data.
const said = (s: Surface, path: string, fields: Record<string, unknown>) => {
  const w = s.word(path);
  return typeof w === 'string' ? s.format(w, fields) : `${path}: ${JSON.stringify(fields)}`;
};

// update <name> --accept: show what waits and why, ask, and take it only on a yes.
async function acceptHeld(ctx: Context, s: Surface, io: Io, positionals: readonly string[], target: Target, withActing: (t: string) => string): Promise<number> {
  const fail = (e: unknown) => {
    io.stderr(withActing(renderError(s, toCatalogError(e, ctx.settings.home, ctx.now()))) + '\n');
    return 1;
  };
  if (positionals.length !== 1) {
    io.stderr(usage(s));
    return 1;
  }
  const name = positionals[0]!;
  let hold: Awaited<ReturnType<typeof pendingHold>>;
  try {
    hold = await pendingHold(ctx, name, target);
  } catch (e) {
    return fail(e);
  }
  if (hold === null) return fail(new CatalogError('not_installed', { name }));
  if (!('confirm' in hold)) {
    io.stdout(withActing(said(s, 'update.accept_nothing_held', { name, version: hold.installed })) + '\n');
    return 0;
  }
  const first = hold.installed === undefined;
  const at = { name, from: hold.installed, to: hold.version, reasons: hold.reasons };
  io.stdout(said(s, first ? 'update.accept_intro_install' : 'update.accept_intro', at) + '\n' + said(s, first ? 'update.accept_look_install' : 'update.accept_look', at) + '\n');
  const answer = await io.ask(said(s, 'update.accept_ask', {}));
  if (!/^y(es)?$/i.test(answer.trim())) {
    io.stdout(withActing(said(s, first ? 'update.accept_declined_install' : 'update.accept_declined', at)) + '\n');
    logAccept(ctx.settings, s, `${name} v${hold.version}`, logWords(s).result('accept_declined'));
    return 0;
  }
  const a = await perform(ctx, 'accept_held_update', 'update --accept', { name, confirm: hold.confirm, flags: hold.flags });
  (a.isError ? io.stderr : io.stdout)(a.text + '\n');
  return a.isError ? 1 : 0;
}
