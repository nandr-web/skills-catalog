// skills-catalog update [<name>...]: installed skills brought up to date, anything flagged held for the person (--dry-run,
// --latest). And the person-only step, update <name> --accept (--target user|project for a held first install): show
// what waits and why, ask in the person's own terminal, and take it only on a yes. Without a terminal it refuses (exit
// 3, run.ts), a backstop only, since a command can fake a terminal; setup never pre-allows it, so an assistant running
// it meets the permission prompt.
import { CatalogError, renderError, toCatalogError, type Surface } from '@skills-catalog/core';
import { appendActivity, logWords } from '../../activity.ts';
import { pendingHold } from '../../machine/installer.ts';
import type { Target } from '../../machine/lock.ts';
import { perform } from '../../operations.ts';
import type { Settings } from '../../settings.ts';
import { recordUsage } from '../../usage/record.ts';
import { fromSchemaFlags, schemaFlags, Usage, type Command, type Env } from '../command.ts';

const own = schemaFlags('update_installed_skills', ['names']);
const TARGETS: readonly unknown[] = ['user', 'project'];

export const update: Command = {
  op: 'update_installed_skills',
  flags: { ...own, accept: { type: 'boolean' }, target: { type: 'string' } },
  personOnly: ['accept'],
  personOnlyOp: 'accept_held_update',
  input(words, values) {
    // --accept takes one skill; --target says where a held first install goes, so it goes only with --accept. Checked
    // before the person-only step, so a person is never given a command that can't work.
    if (values['accept'] === true && words.length !== 1) throw new Usage();
    if (values['target'] !== undefined && (values['accept'] !== true || !TARGETS.includes(values['target']))) throw new Usage();
    const args = fromSchemaFlags(own, values);
    if (words.length) args['names'] = [...words];
    return args;
  },
  run: (env) => (env.values['accept'] === true ? acceptHeld(env) : undefined),
};

/** The activity-log line for the parts of update --accept that no operation logs: refused without a terminal, and the
 *  person's no. The target is a skill's name (and version), never other text. */
export function logAccept(settings: Settings, s: Surface, target: string, result: string): void {
  const log = logWords(s);
  appendActivity(settings.activityLog, { at: new Date(), who: settings.developer, tool: 'update --accept', target, result }, { ownFolder: settings.activityLogInHome, resultWidth: log.width });
}

// Words the CLI waits for from the surface (the --accept words); until they're vendored each shows as its data.
const said = (s: Surface, path: string, fields: Record<string, unknown>) => {
  const w = s.word(path);
  return typeof w === 'string' ? s.format(w, fields) : `${path}: ${JSON.stringify(fields)}`;
};

async function acceptHeld({ ctx, s, io, words, values, withActing }: Env): Promise<number> {
  // Each way this ends counts once as a use (a yes is counted by perform, as the accept runs).
  const used = (result: string) => recordUsage(ctx.settings.home, { event: 'use', op: 'accept_held_update', result }, ctx.now());
  const fail = (e: unknown) => {
    const err = toCatalogError(e, ctx.settings.home, ctx.now());
    io.stderr(withActing(renderError(s, err)) + '\n');
    used(err.code);
    return 1;
  };
  const name = words[0]!;
  const target = (values['target'] as Target | undefined) ?? 'user';
  let hold: Awaited<ReturnType<typeof pendingHold>>;
  try {
    hold = await pendingHold(ctx, name, target);
  } catch (e) {
    return fail(e);
  }
  if (hold === null) return fail(new CatalogError('not_installed', { name }));
  if (!('confirm' in hold)) {
    io.stdout(withActing(said(s, 'update.accept_nothing_held', { name, version: hold.installed })) + '\n');
    used('nothing_held');
    return 0;
  }
  const first = hold.installed === undefined;
  const at = { name, from: hold.installed, to: hold.version, reasons: hold.reasons, path: hold.path };
  // A first install names where it goes; a "tell me first" update with nothing flagged has no reasons to give.
  const intro = first ? 'update.accept_intro_install' : hold.notify && !hold.flags.length ? 'update.accept_intro_notify' : 'update.accept_intro';
  io.stdout(said(s, intro, at) + '\n' + said(s, first ? 'update.accept_look_install' : 'update.accept_look', at) + '\n');
  // Showing the person the reasons is a look (usage metrics); their no is an answer. Their yes is an answer too, for the
  // installer to record where a held update is taken, on every face: not recorded yet (usage-look.test.ts says so).
  recordUsage(ctx.settings.home, { event: 'look', skill: name, version: hold.version, surface: 'cli' }, ctx.now(), { createKey: true });
  const answer = await io.ask(said(s, 'update.accept_ask', {}));
  if (!/^y(es)?$/i.test(answer.trim())) {
    io.stdout(withActing(said(s, first ? 'update.accept_declined_install' : 'update.accept_declined', at)) + '\n');
    logAccept(ctx.settings, s, `${name} v${hold.version}`, logWords(s).result('accept_declined'));
    recordUsage(ctx.settings.home, { event: 'answer', skill: name, version: hold.version, answer: 'no', together: 1 }, ctx.now(), { createKey: true });
    used('declined');
    return 0;
  }
  const a = await perform(ctx, 'accept_held_update', 'update --accept', { name, confirm: hold.confirm, flags: hold.flags });
  (a.isError ? io.stderr : io.stdout)(a.text + '\n');
  return a.isError ? 1 : 0;
}
