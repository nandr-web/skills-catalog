// Runs the CLI face in-process against a sandboxed place, the way the real command would (test/cli.test.ts shows the
// real command matches): the environment points only into the sandbox, answers stand in for the person at a terminal.
import { join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { runCli, type Io } from '../src/cli/run.ts';
import { cliWords } from '../src/cli/words.ts';
import type { Place } from './server.ts';

export const S = cliWords(Words.load());

export type Ran = { code: number; out: string; err: string; asked: string[] };

export async function cli(p: Place, argv: string[], o: { tty?: boolean; person?: boolean; color?: boolean; answers?: string[]; env?: Record<string, string>; cwd?: string } = {}): Promise<Ran> {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const answers = [...(o.answers ?? [])];
  const io: Io = {
    env: { SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed, ...o.env },
    cwd: o.cwd ?? join(p.dir, 'project'),
    tty: o.tty ?? false,
    ...(o.person === undefined ? {} : { person: o.person }),
    ...(o.color === undefined ? {} : { color: o.color }),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? '';
    },
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  const code = await runCli(argv, io);
  return { code, out: out.join(''), err: err.join(''), asked };
}

/** The activity log's last line, as its columns after the time: who, tool, result, target. */
export async function lastLogLine(p: Place): Promise<string[]> {
  const { readFileSync } = await import('node:fs');
  return readFileSync(join(p.home, 'activity.log'), 'utf8').trimEnd().split('\n').at(-1)!.split(/\s{2,}/).slice(1);
}

/** A read's or a diff's fence token is made per call: the same text with every token as T. */
export const TOKEN = { next: () => 'T' };
export const fixedTokens = (text: string) => text.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, 'T');
