// Where the client reads and writes, and who it acts as (contract §7, §8), from the environment it was started with:
// an assistant's MCP config for the server, the person's shell for the CLI.
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A developer's name as the core accepts a publisher's (its ACTOR rule), kept in step with the core until the core
// exports its check.
const DEVELOPER = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type Settings = {
  /** SKILLS_HOME (default ~/.skills-catalog): config, lock file, logs. */
  home: string;
  /** SKILLS_CATALOG: file:///… is the local catalog (default $SKILLS_HOME/catalog), https://… a hosted one. */
  catalog: string;
  /** SKILLS_ACTIVITY_LOG (default $SKILLS_HOME/activity.log): one line per tool call, for the demo. */
  activityLog: string;
  /** SKILLS_AS: the developer you act as locally (a demo identity, not security), when it is a developer's name. */
  developer?: string;
  /** SKILLS_AS was set to something that isn't a developer's name: every call says so, and nothing is done. */
  developerInvalid: boolean;
};

export function settingsFrom(env: Record<string, string | undefined>): Settings {
  const home = resolve(env['SKILLS_HOME'] || join(homedir(), '.skills-catalog'));
  const as = env['SKILLS_AS'] || undefined;
  const valid = as !== undefined && DEVELOPER.test(as);
  return {
    home,
    catalog: env['SKILLS_CATALOG'] || pathToFileURL(join(home, 'catalog')).href,
    activityLog: resolve(env['SKILLS_ACTIVITY_LOG'] || join(home, 'activity.log')),
    ...(valid ? { developer: as } : {}),
    developerInvalid: as !== undefined && !valid,
  };
}
