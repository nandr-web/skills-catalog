// skills-catalog publish <folder> [--message …]: the assistant's tool publish_skill_to_catalog on the command line (P2.5,
// P5.4; contract §3), the same one operation in its two steps, so the words, the checks and the activity log are the same.
// A person at a terminal runs it alone: the preview's lists, "Publish ...? (y/N)", and the publish on a yes (y or yes,
// any case; anything else, or the input ending, is a no). With no terminal and none of step 2's values, only the preview
// runs (it stores nothing) and the exact step-2 command is printed, exit 3: it needs the person's yes, and setup never
// pre-allows it, so an assistant running it meets the permission prompt. With step 2's values (--confirm, --name,
// --version, --files, --flags) it publishes exactly what the preview showed, or refuses. --allow-suspected-secrets is the
// person's (run.ts refuses it with no terminal).
import { shellQuote } from '@skills-catalog/core';
import { flagText } from '@skills-catalog/core/skill-tree';
import { perform, type Answer } from '../../operations.ts';
import { terminal } from '../../person/medium.ts';
import { personView } from '../../person/view.ts';
import { exactly, fromSchemaFlags, schemaFlags, type Command, type Env } from '../command.ts';

const own = schemaFlags('publish_skill_to_catalog', ['folder']);
const STEP2 = ['confirm', 'name', 'version', 'files', 'flags'];

type Preview = { kind: 'publish_preview'; fields: Record<string, unknown>; step2: { folder: string; confirm: string; name: string; version: number; files: number; flags: string[]; message: string | null } };

export const publish: Command = {
  op: 'publish_skill_to_catalog',
  flags: own,
  personOnly: ['allow-suspected-secrets'],
  input: (words, values) => ({ ...exactly(words, ['folder']), ...fromSchemaFlags(own, values) }),
  run: (env) => (STEP2.some((f) => env.values[f] !== undefined) ? undefined : previewFirst(env)),
};

/** The step-2 command as one line the person or a shell can run: each value its own quoted word (`--flag=value`, so a
 *  confirm that starts with a dash stays that flag's value). */
function step2Command(cli: string, p: Preview['step2']): string {
  const words = [`--confirm=${p.confirm}`, `--name=${p.name}`, `--version=${p.version}`, `--files=${p.files}`, `--flags=${p.flags.length ? p.flags.join(',') : 'none'}`, ...(p.message === null ? [] : [`--message=${p.message}`])];
  return [cli, 'publish', shellQuote(flagText(p.folder)), ...words.map((w) => shellQuote(flagText(w)))].join(' ');
}

async function previewFirst(env: Env): Promise<number> {
  const { ctx, s, io, input, withActing } = env;
  // A refusal for a person reading a terminal: their view of it (person/view.ts), else the operation's words.
  const refusal = (a: Answer) => (io.person ? withActing(personView(s, terminal(io.color === true), 'publish_skill_to_catalog', a, input) ?? a.text) : a.text);
  const seen = await perform(ctx, 'publish_skill_to_catalog', 'publish', input);
  const view = seen.view as Preview | undefined;
  if (seen.isError || view?.kind !== 'publish_preview') {
    // A refusal, or nothing to publish (identical to the latest): the operation's own words.
    (seen.isError ? io.stderr : io.stdout)((seen.isError ? refusal(seen) : seen.text) + '\n');
    return seen.isError ? 1 : 0;
  }
  const preview = s.format(s.word('publish.preview_person'), view.fields).trimEnd();
  if (!io.tty) {
    io.stdout(withActing(`${preview}\n${s.format(s.word('publish.step2_cli'), { command: step2Command(s.cli, view.step2) })}`) + '\n');
    return 3;
  }
  io.stdout(preview + '\n');
  const answer = await io.ask(s.format(s.word('publish.ask_person'), { name: view.step2.name, version: view.step2.version })).catch(() => '');
  if (!/^y(es)?$/i.test(answer.trim())) {
    io.stdout(withActing(s.word('publish.declined_person')) + '\n');
    return 0;
  }
  const { folder: _, message, ...values } = view.step2;
  const a = await perform(ctx, 'publish_skill_to_catalog', 'publish', {
    folder: input['folder'],
    ...values,
    ...(message === null ? {} : { message }),
    ...(input['allow_suspected_secrets'] === true ? { allow_suspected_secrets: true } : {}),
  });
  (a.isError ? io.stderr : io.stdout)((a.isError ? refusal(a) : a.text) + '\n');
  return a.isError ? 1 : 0;
}
