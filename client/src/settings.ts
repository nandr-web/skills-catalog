// Where the client reads and writes, and who it acts as (contract §7, §8), from the environment it was started with:
// an assistant's MCP config for the server, the person's shell for the CLI.
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTOR } from '@skills-catalog/core';


export type Settings = {
  /** SKILLS_HOME (default ~/.skills-catalog): config, lock file, logs. */
  home: string;
  /** SKILLS_CATALOG: file:///… is the local catalog (default $SKILLS_HOME/catalog), https://… a hosted one. */
  catalog: string;
  /** SKILLS_ACTIVITY_LOG (default $SKILLS_HOME/activity.log): one line per tool call, for the demo. */
  activityLog: string;
  /** The log sits directly in SKILLS_HOME, the client's own folder (kept 0700); a folder the person named is theirs. */
  activityLogInHome: boolean;
  /** SKILLS_AS: the developer you act as locally (a demo identity, not security), when it is a developer's name. */
  developer?: string;
  /** SKILLS_AS was set to something that isn't a developer's name: every call says so, and nothing is done. */
  developerInvalid: boolean;
  /** SKILLS_ASSISTANT_HOME (default: the OS home): the assistant's own files; the user target is <it>/.claude/skills. */
  assistantHome: string;
  /** The project a project install goes into (<it>/.claude/skills): the folder the client was started in. */
  projectDir: string;
};

export function settingsFrom(env: Record<string, string | undefined>, cwd: string = process.cwd()): Settings {
  const home = resolve(env['SKILLS_HOME'] || join(homedir(), '.skills-catalog'));
  const as = env['SKILLS_AS'] || undefined;
  const valid = as !== undefined && ACTOR.test(as);   // a developer's name, by the core's rule for a publisher
  const activityLog = resolve(env['SKILLS_ACTIVITY_LOG'] || join(home, 'activity.log'));
  return {
    home,
    catalog: env['SKILLS_CATALOG'] || pathToFileURL(join(home, 'catalog')).href,
    activityLog,
    activityLogInHome: dirname(activityLog) === home,
    ...(valid ? { developer: as } : {}),
    developerInvalid: as !== undefined && !valid,
    assistantHome: resolve(env['SKILLS_ASSISTANT_HOME'] || homedir()),
    projectDir: resolve(cwd),
  };
}
