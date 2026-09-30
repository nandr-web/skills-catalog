// The client's operations, whatever the face (contract §1): one definition runs them all. Each operation's row (the
// core's api.ts) names what runs it, a Catalog method or a machine function (machine/index.ts); the run gives data, and
// each face presents it: the MCP's and the CLI's text through the core's renderers, the web face never (it sends the
// data). `perform` is one call on any face: the face's check, the acting developer's check, the operation, an error in
// words (a bug is internal_error, its traceback in a log file under SKILLS_HOME, never shown), the activity log's line,
// the usage metrics' `use` event, and the "acting as" line.
import { actAs, CatalogError, OPERATIONS, openCatalog, randomIds, renderDiff, renderError, renderRead, renderSearch, renderVersions, toCatalogError, type Catalog, type Face, type Ids, type ReadItem, type SearchInput, type Words } from '@skills-catalog/core';
import { dispatch } from '@skills-catalog/core/http';
import { appendActivity, logWords } from './activity.ts';
import { MACHINE } from './machine/index.ts';
import { catalogToken, type Settings } from './settings.ts';
import { recordUsage } from './usage/record.ts';

export type { Face };

/** Everything an operation needs, the same on every face. `face` says which one asks: an input only a person may give
 *  (the CLI's) is refused from the assistant's (MCP). `ids` makes the fence tokens around a publisher's text. `refuse`:
 *  a face's own refusal of this call (e.g. the local page's read-only rule), raised like any error, so it's logged too. */
export type Context = { catalog: () => Promise<Catalog>; words: Words; settings: Settings; face: Face; now: () => Date; ids: Ids; refuse?: (op: string, args: unknown) => void };

/** What a run gives: its data, and the activity log's target and result (the result in the words file's log words:
 *  logWords(ctx.words).result). `outcome`, a code, where the operation has one worth counting or acting on (a search's
 *  match, "none_found" for a read that found none of its names); absent means "ok". */
export type Ran = { data: unknown; target: string; result: string; outcome?: string; view?: unknown };

/** A machine operation's run: its text today (its row's output is 'text'), with the log's target and result. `view`:
 *  the same result as data, for a face that lays it out for a person (the CLI at a terminal, person/view.ts). */
export type Done = { text: string; target: string; result: string; outcome?: string; view?: unknown };
export type MachineRun = (ctx: Context, args: unknown) => Promise<Done>;

/** Words the client waits for from the words file, as paths from the words file's top. Until one lands it's shown
 *  as data, and a test fails the moment it appears in the vendored words, so it gets wired. */
export const CLIENT_WORD_GAPS: readonly string[] = [];

const NONE = '-';

// Where a look happened, by face (usage metrics).
const LOOK_FACE: Record<Face, 'cli' | 'assistant' | 'web'> = { mcp: 'assistant', cli: 'cli', web: 'web' };

// A catalog operation on this client: after the Catalog method its row names has run, what the log shows (the target
// comes from the result, the skills it returned or a match count, never from the arguments, which can hold anything),
// and how the MCP and CLI faces word the result (the core's renderers).
type CatalogOp = { log(ctx: Context, data: any): Omit<Ran, 'data'>; present?(ctx: Context, data: any, args: unknown): string };
const CATALOG_OPS: Record<string, CatalogOp> = {
  search_shared_skills: {
    log: (ctx, r) => {
      const log = logWords(ctx.words);
      return { target: log.searchTarget(r.total_matches, r.catalog_size), result: log.result('search', r.match), outcome: r.match };
    },
    present: (ctx, r, args) => renderSearch(ctx.words, r, (args ?? {}) as SearchInput),
  },
  read_shared_skill: {
    log: (ctx, r) => {
      const items = (r.skills as unknown[]).filter((e): e is ReadItem => !(e as object && 'error' in (e as object)));
      return { target: items.map((i) => `${i.name} v${i.version}`).join(', ') || NONE, result: logWords(ctx.words).result('get'), ...(items.length ? {} : { outcome: 'none_found' }) };
    },
    present: (ctx, r) => renderRead(ctx.words, r, ctx.ids),
  },
  list_shared_skill_versions: {
    log: (ctx, r) => ({ target: `${r.name} v${r.latest}`, result: logWords(ctx.words).result('versions') }),
    present: (ctx, r) => renderVersions(ctx.words, r),
  },
  diff_shared_skill_versions: {
    log: (ctx, r) => {
      const outcome = r.risk_flags.length ? 'runnable' : 'text_only';
      // A look at the version it goes to; the usage summary counts it only when that version was held.
      recordUsage(ctx.settings.home, { event: 'look', skill: r.name, version: r.to, face: LOOK_FACE[ctx.face] }, ctx.now());
      return { target: `${r.name} v${r.from} → v${r.to}`, result: logWords(ctx.words).result('diff', outcome), outcome };
    },
    present: (ctx, r) => renderDiff(ctx.words, r, ctx.ids),
  },
  // The web's own (faces: web only, never presented): a publish, a dry run included, and fetching a version's files.
  publish_version: {
    log: (ctx, r) => ({ target: `${r.name} v${r.version}`, result: logWords(ctx.words).result('publish', r.dry_run ? 'preview' : 'published') }),
  },
  fetch_version: {
    log: (ctx, r) => ({ target: `${r.name} v${r.version}`, result: logWords(ctx.words).result('fetch') }),
  },
};

/** Runs an operation through its row: a Catalog method, or a machine function (whose data is its text today). */
async function run(ctx: Context, op: string, args: unknown): Promise<Ran> {
  const row = OPERATIONS[op]!;
  const machine = Object.hasOwn(MACHINE, row.run) ? MACHINE[row.run]! : undefined;
  if (machine) {
    const { text, ...rest } = await machine(ctx, args);
    return { data: text, ...rest };
  }
  const catalogOp = CATALOG_OPS[op];
  if (!catalogOp) throw new Error(`no run for ${op} on this client yet`);
  // The core's one per-method call (publish's identity in its own slot), the same one the web API dispatches through.
  const data = await dispatch(op, args, { catalog: await ctx.catalog(), developer: ctx.settings.developer, face: ctx.face });
  return { data, ...catalogOp.log(ctx, data) };
}

/** How the MCP and CLI faces word an operation's data; the web face never presents (it sends the data). */
function present(ctx: Context, op: string, data: unknown, args: unknown): string {
  const catalogOp = CATALOG_OPS[op];
  return catalogOp?.present ? catalogOp.present(ctx, data, args) : String(data);
}

/** The operations this client runs, by operation name: each with a machine function or a catalog operation here. */
export const RUNS: Record<string, true> = Object.fromEntries(
  Object.entries(OPERATIONS).flatMap(([op, row]) => (Object.hasOwn(MACHINE, row.run) || Object.hasOwn(CATALOG_OPS, op) ? [[op, true as const]] : [])),
);

/** The line after every result and error while a developer is set (contract §7, "acting as"). */
export const actingAs = (s: Words, developer: string) => s.format(s.word('acting_as'), { developer });

/** `text`: the face's words ('' on the web face, which presents nothing); `data`: the operation's data, on success
 *  only; `error`: the error, on failure only; `outcome`: the operation's outcome code, or the error's code. */
export type Answer = { text: string; isError: boolean; outcome: string; data?: unknown; view?: unknown; error?: CatalogError };

/** One operation on any face: `op` is the API's name, `name` what this face calls it (for the log). */
export async function perform(ctx: Context, op: string, name: string, args: unknown): Promise<Answer> {
  const row = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : undefined;
  if (!row || !RUNS[op]) throw new Error(`no operation ${op}`);
  // A backstop only: each face offers only what it serves (the MCP lists its tools from the rows' faces, the CLI's
  // commands name only operations it serves, and the web's routes are built from the rows' faces), so no face relies on
  // this check. It throws before the try: no activity or usage line for a call no face offers.
  if (!row.faces.includes(ctx.face)) throw new Error(`${op} is not served on the ${ctx.face} face`);
  const { settings, words } = ctx;
  const log = logWords(words);
  const web = ctx.face === 'web';
  let answer: Answer;
  let target: string;
  let result: string;
  try {
    // SKILLS_AS that isn't a developer's name is a setting to fix, not a call to retry.
    if (settings.developerInvalid) throw new CatalogError('invalid_developer_setting', { setting: 'SKILLS_AS' });
    ctx.refuse?.(op, args);
    const ran = await run(ctx, op, args);
    ({ target, result } = ran);
    answer = { text: web ? '' : present(ctx, op, ran.data, args), isError: false, outcome: ran.outcome ?? 'ok', data: ran.data, ...(ran.view === undefined ? {} : { view: ran.view }) };
  } catch (e) {
    const err = toCatalogError(e, settings.home, ctx.now());
    // A local catalog has no sign-in: no developer name is a setup matter, in its own words (not "run login").
    const local = err.code === 'unauthenticated' && settings.catalog.startsWith('file:');
    target = NONE;
    result = log.error(err.code);
    answer = { text: web ? '' : local ? words.word('errors.unauthenticated_local') : renderError(words, err), isError: true, outcome: err.code, error: err };
  }
  appendActivity(settings.activityLog, { at: ctx.now(), who: settings.developer, tool: name, target, result }, { ownFolder: settings.activityLogInHome, resultWidth: log.width });
  recordUsage(settings.home, { event: 'use', op, result: answer.outcome }, ctx.now());
  if (settings.developer && !web) answer.text = `${answer.text}\n${actingAs(words, settings.developer)}`;
  return answer;
}

/** The catalog, opened on first use, so a catalog that can't be opened is an error the assistant reads, not a server
 *  that won't start; a failed open is tried again next time. */
export function lazyCatalog(settings: Settings): { get: () => Promise<Catalog>; close: () => void } {
  let opened: Promise<Catalog> | undefined;
  return {
    get: () =>
      (opened ??= openCatalog(settings.catalog, { identity: actAs(settings.developer), token: catalogToken(settings) }).catch((e) => {
        opened = undefined;
        throw e;
      })),
    close: () => void opened?.then((c) => c.close()).catch(() => {}),
  };
}

/** A context for a face: the catalog opened lazily, fence tokens from the core's random ids. */
export function contextFor(settings: Settings, words: Words, face: Face, now: () => Date = () => new Date()): { ctx: Context; close: () => void } {
  const catalog = lazyCatalog(settings);
  return { ctx: { catalog: catalog.get, words, settings, face, now, ids: randomIds }, close: catalog.close };
}
