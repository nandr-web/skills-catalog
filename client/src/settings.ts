// Where the client reads and writes, and who it acts as (contract §7, §8), from the environment it was started with:
// an assistant's MCP config for the server, the person's shell for the CLI.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ACTOR, CatalogError } from '@skills-catalog/core';
import { readConfig } from './machine/lock.ts';


export type Settings = {
  /** SKILLS_HOME (default ~/.skills-catalog): config, lock file, logs. */
  home: string;
  /** SKILLS_CATALOG: file:///… is the local catalog (default $SKILLS_HOME/catalog), https://… a hosted one. */
  catalog: string;
  /** SKILLS_ACTIVITY_LOG (default $SKILLS_HOME/activity.log): one line per tool call, for the demo. */
  activityLog: string;
  /** The log sits directly in SKILLS_HOME, the client's own folder (kept 0700); a folder the person named is theirs. */
  activityLogInHome: boolean;
  /** The developer you act as on a local catalog (a demo identity, not security): SKILLS_AS (or the CLI's --as), else
   *  setup's `me` in config.json, else this computer's login made into a developer name (machineDeveloper). */
  developer?: string;
  /** Where `developer` came from: the login default says so on every result, in its own words (actingLine). */
  developerSource?: 'env' | 'config' | 'machine';
  /** SKILLS_AS was set to something that isn't a developer's name: every call says so, and nothing is done. */
  developerInvalid: boolean;
  /** config.json is there but can't be used: who acts and where the catalog is can't be known, so every call names the
   *  damage (invalid_local_file) and nothing is done; never the login or the default catalog in its place. */
  configError?: CatalogError;
  /** SKILLS_ASSISTANT_HOME (default: the OS home): the assistant's own files; the user target is <it>/.claude/skills. */
  assistantHome: string;
  /** The project a project install goes into (<it>/.claude/skills): the folder the client was started in. */
  projectDir: string;
  /** SKILLS_TOKEN: a hosted catalog's Bearer token; else the one skills-catalog login saved ($SKILLS_HOME/token). */
  token?: string;
  /** SKILLS_MANAGED_SETTINGS (default: Claude Code's managed-settings folder for this system): read, never written, to
   *  tell a permissive mode (contract §5.3). Tests always point it into their sandbox. */
  managedSettings: string;
  /** SKILLS_INSTALL_DIR: stands in for the user target's <assistant home>/.claude/skills (contract §8): the checks run on it
   *  and its parent, and staging goes beside it. Tests point it into their sandbox. */
  installDir?: string;
};

/** The file skills-catalog login saves a hosted catalog's token in (0600, in the client's own folder). */
export const tokenFile = (s: Settings) => join(s.home, 'token');

/** The token a hosted catalog is opened with: SKILLS_TOKEN, else the saved one, else none (every call is then
 *  unauthenticated, whose words say to sign in). */
export function catalogToken(s: Settings): string | undefined {
  if (s.token) return s.token;
  try {
    return readFileSync(tokenFile(s), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Claude Code's managed-settings folder: macOS, else Linux and WSL (its managed-settings page). */
const MANAGED_SETTINGS = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';

/** This computer's login (USER, else LOGNAME, as a terminal and an MCP client pass them) made into a developer name:
 *  lowercased, accents dropped, each run of other characters one hyphen, trimmed to 64; undefined when nothing is left.
 *  Read from the environment, never by asking the system, so a process started with a bare environment (a test's) has no
 *  login default. Setup offers the same name as its default for `me`, so a skill published before setup keeps its owner. */
export function machineDeveloper(env: Record<string, string | undefined>): string | undefined {
  const login = env['USER'] || env['LOGNAME'];
  if (!login) return undefined;
  const name = login
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return ACTOR.test(name) ? name : undefined;
}

/** config.json as far as settings need it (who acts, where the catalog is), or why it can't be used. */
function configured(home: string): { me?: string; catalog?: string; error?: CatalogError } {
  try {
    const c = readConfig(home);
    return { ...(typeof c['me'] === 'string' ? { me: c['me'] } : {}), ...(typeof c['catalog'] === 'string' ? { catalog: c['catalog'] } : {}) };
  } catch (e) {
    if (e instanceof CatalogError) return { error: e };
    throw e;
  }
}

export function settingsFrom(env: Record<string, string | undefined>, cwd: string = process.cwd()): Settings {
  const home = resolve(env['SKILLS_HOME'] || join(homedir(), '.skills-catalog'));
  const config = configured(home);
  // config.json's catalog may be a folder's absolute path (contract §6) or an address.
  const configCatalog = config.catalog && isAbsolute(config.catalog) ? pathToFileURL(config.catalog).href : config.catalog;
  const catalog = env['SKILLS_CATALOG'] || configCatalog || pathToFileURL(join(home, 'catalog')).href;
  const as = env['SKILLS_AS'] || undefined;
  const valid = as !== undefined && ACTOR.test(as);   // a developer's name, by the core's rule for a publisher
  // A local catalog's mocked sign-in: setup's name, else the login. A hosted catalog's is its token, never these. The
  // login stands in only on the default catalog ($SKILLS_HOME/catalog, this machine's own): on a catalog named elsewhere,
  // perhaps shared, two people's logins can map to one name, so taking someone's name must be a choice (me or SKILLS_AS).
  const local = catalog.startsWith('file:');
  const ownCatalog = catalog === pathToFileURL(join(home, 'catalog')).href;
  const fallback = as !== undefined || !local || config.error ? undefined : config.me ? { developer: config.me, developerSource: 'config' as const } : (() => {
    const m = ownCatalog ? machineDeveloper(env) : undefined;
    return m ? { developer: m, developerSource: 'machine' as const } : undefined;
  })();
  const activityLog = resolve(env['SKILLS_ACTIVITY_LOG'] || join(home, 'activity.log'));
  return {
    home,
    catalog,
    activityLog,
    activityLogInHome: dirname(activityLog) === home,
    ...(valid ? { developer: as, developerSource: 'env' as const } : (fallback ?? {})),
    developerInvalid: as !== undefined && !valid,
    ...(config.error ? { configError: config.error } : {}),
    assistantHome: resolve(env['SKILLS_ASSISTANT_HOME'] || homedir()),
    projectDir: resolve(cwd),
    ...(env['SKILLS_TOKEN'] ? { token: env['SKILLS_TOKEN'] } : {}),
    managedSettings: resolve(env['SKILLS_MANAGED_SETTINGS'] || MANAGED_SETTINGS),
    // As given: a relative one is refused where it's used (the user target), never resolved against wherever this runs.
    ...(env['SKILLS_INSTALL_DIR'] ? { installDir: env['SKILLS_INSTALL_DIR'] } : {}),
  };
}
