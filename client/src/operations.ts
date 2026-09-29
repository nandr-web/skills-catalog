// The client's operations, whatever the face: the MCP server now, the CLI next. Each runs the core's operation and puts
// its result through the core's renderer, so every face says the same thing. `perform` is one call on any face: the
// acting developer's check, the operation, an error in words (a bug is internal_error, its traceback in a log file
// under SKILLS_HOME, never shown), the activity log's line, and the "acting as" line.
import { actAs, CatalogError, openCatalog, randomIds, renderDiff, renderError, renderRead, renderSearch, renderVersions, toCatalogError, type Catalog, type Ids, type ReadItem, type SearchInput, type Surface } from '@skills-catalog/core';
import { appendActivity, logWords } from './activity.ts';
import { MACHINE_RUNS } from './machine/index.ts';
import type { Settings } from './settings.ts';

/** Everything an operation needs, the same on every face. `face` says which one asks: an input only a person may give
 *  (the CLI's) is refused from the assistant's (MCP). `ids` makes the fence tokens around a publisher's text. */
export type Face = 'mcp' | 'cli';
export type Context = { catalog: () => Promise<Catalog>; surface: Surface; settings: Settings; face: Face; now: () => Date; ids: Ids };

/** What an operation gives: the text for the assistant (or the person), and the activity log's target and result (the
 *  result in the surface's log words: logWords(surface).result). */
export type Done = { text: string; target: string; result: string };
export type Run = (ctx: Context, args: unknown) => Promise<Done>;

/** Words the client waits for from the agent-facing surface, as paths from the surface's top. Until one lands it's shown
 *  as data, and a test fails the moment it appears in the vendored surface, so it gets wired. None today. */
export const CLIENT_WORD_GAPS: readonly string[] = [];

const NONE = '-';

/** The catalog's operations, keyed by the registry's operation name; each face names it its own way (the MCP tool's name
 *  is the surface's). The target comes from the result (the skills it returned, a match count), never from the
 *  arguments, which can hold anything. */
export const CATALOG_RUNS: Record<string, Run> = {
  async search_shared_skills(ctx, args) {
    const r = await (await ctx.catalog()).search(args);
    const log = logWords(ctx.surface);
    return { text: renderSearch(ctx.surface, r, (args ?? {}) as SearchInput), target: log.searchTarget(r.total_matches, r.catalog_size), result: log.result('search', r.match) };
  },

  async read_shared_skill(ctx, args) {
    const r = await (await ctx.catalog()).read(args);
    const items = r.skills.filter((e): e is ReadItem => !('error' in e));
    return { text: renderRead(ctx.surface, r, ctx.ids), target: items.map((i) => `${i.name} v${i.version}`).join(', ') || NONE, result: logWords(ctx.surface).result('get') };
  },

  async list_shared_skill_versions(ctx, args) {
    const r = await (await ctx.catalog()).versions(args);
    return { text: renderVersions(ctx.surface, r), target: `${r.name} v${r.latest}`, result: logWords(ctx.surface).result('versions') };
  },

  async diff_shared_skill_versions(ctx, args) {
    const r = await (await ctx.catalog()).diff(args);
    return { text: renderDiff(ctx.surface, r, ctx.ids), target: `${r.name} v${r.from} → v${r.to}`, result: logWords(ctx.surface).result('diff', r.risk_flags.length ? 'runnable' : 'text_only') };
  },
};

/** Every operation the client runs: the catalog's, and the machine's (machine/index.ts). */
export const RUNS: Record<string, Run> = { ...CATALOG_RUNS, ...MACHINE_RUNS };

/** The line after every result and error while a developer is set (contract §7, "acting as"). */
export const actingAs = (s: Surface, developer: string) => s.format(s.word('acting_as'), { developer });

export type Answer = { text: string; isError: boolean };

/** One operation on any face: `op` is the registry's name, `name` what this face calls it (for the log). */
export async function perform(ctx: Context, op: string, name: string, args: unknown): Promise<Answer> {
  const run = RUNS[op];
  if (!run) throw new Error(`no operation ${op}`);
  const { settings, surface } = ctx;
  const log = logWords(surface);
  let done: Done;
  let isError = false;
  try {
    // SKILLS_AS that isn't a developer's name is a setting to fix, not a call to retry.
    if (settings.developerInvalid) throw new CatalogError('invalid_developer_setting', { setting: 'SKILLS_AS' });
    done = await run(ctx, args);
  } catch (e) {
    const err = toCatalogError(e, settings.home, ctx.now());
    // A local catalog has no sign-in: no developer name is a setup matter, in its own words (not "run login").
    const local = err.code === 'unauthenticated' && settings.catalog.startsWith('file:');
    done = { text: local ? surface.word('errors.unauthenticated_local') : renderError(surface, err), target: NONE, result: log.error(err.code) };
    isError = true;
  }
  appendActivity(settings.activityLog, { at: ctx.now(), who: settings.developer, tool: name, target: done.target, result: done.result }, { ownFolder: settings.activityLogInHome, resultWidth: log.width });
  return { text: settings.developer ? `${done.text}\n${actingAs(surface, settings.developer)}` : done.text, isError };
}

/** The catalog, opened on first use, so a catalog that can't be opened is an error the assistant reads, not a server
 *  that won't start; a failed open is tried again next time. */
export function lazyCatalog(settings: Settings): { get: () => Promise<Catalog>; close: () => void } {
  let opened: Promise<Catalog> | undefined;
  return {
    get: () =>
      (opened ??= openCatalog(settings.catalog, { identity: actAs(settings.developer) }).catch((e) => {
        opened = undefined;
        throw e;
      })),
    close: () => void opened?.then((c) => c.close()).catch(() => {}),
  };
}

/** A context for a face: the catalog opened lazily, fence tokens from the core's random ids. */
export function contextFor(settings: Settings, surface: Surface, face: Face, now: () => Date = () => new Date()): { ctx: Context; close: () => void } {
  const catalog = lazyCatalog(settings);
  return { ctx: { catalog: catalog.get, surface, settings, face, now, ids: randomIds }, close: catalog.close };
}
