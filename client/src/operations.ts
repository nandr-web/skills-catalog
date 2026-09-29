// The client's operations, whatever the face: the MCP server now, the CLI next. Each runs the core's operation and puts
// its result through the core's renderer, so every face says the same thing. `perform` is one call on any face: the
// acting developer's check, the operation, an error in words (a bug is internal_error, its traceback in a log file
// under SKILLS_HOME, never shown), the activity log's line, and the "acting as" line.
import { actAs, MANIFEST, openCatalog, renderDiff, renderError, renderRead, renderSearch, renderVersions, toCatalogError, type Catalog, type ReadItem, type Surface } from '@skills-catalog/core';
import { appendActivity } from './activity.ts';
import { MACHINE_RUNS } from './machine/index.ts';
import type { Settings } from './settings.ts';

/** Everything an operation needs, the same on every face. */
export type Context = { catalog: () => Promise<Catalog>; surface: Surface; settings: Settings; now: () => Date };

/** What an operation gives: the text for the assistant (or the person), and the activity log's target and result. */
export type Done = { text: string; target: string; result: string };
export type Run = (ctx: Context, args: unknown) => Promise<Done>;

/** Words the client waits for from the agent-facing surface, as paths from the surface's top. Until one lands it's shown
 *  as data, and a test fails the moment it appears in the vendored surface, so it gets wired. */
export const CLIENT_WORD_GAPS = ['results.acting_as', 'log', 'results.errors.invalid_developer_setting'] as const;

const OK = 'ok';
const NONE = '-';

/** A search cursor's offset, so a later page says which cards it shows. The core's cursor is base64url JSON {o};
 *  this reads it until the core exports its own reader. Called only after the core accepted the cursor. */
function offsetOf(cursor: unknown): number {
  if (typeof cursor !== 'string') return 0;
  const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
  return Number.isInteger(o) ? o : 0;
}

const field = (args: unknown, key: string): unknown => (args && typeof args === 'object' ? (args as Record<string, unknown>)[key] : undefined);

/** The catalog's operations, keyed by the registry's operation name; each face names it its own way (the MCP tool's name
 *  is the surface's). The target comes from the result (the skills it returned, a match count), never from the
 *  arguments, which can hold anything. */
export const CATALOG_RUNS: Record<string, Run> = {
  async search_shared_skills(ctx, args) {
    const r = await (await ctx.catalog()).search(args);
    const query = field(args, 'query');
    return { text: renderSearch(ctx.surface, r, typeof query === 'string' ? query : '', offsetOf(field(args, 'cursor'))), target: `${r.total_matches}/${r.catalog_size}`, result: OK };
  },

  async read_shared_skill(ctx, args) {
    const c = await ctx.catalog();
    const r = await c.read(args);
    const items = r.skills.filter((e): e is ReadItem => !('error' in e));
    // Each SKILL.md as published, for the renderer (which takes it synchronously).
    const md = new Map<string, string>();
    for (const i of items) {
      const f = (await c.fetch({ name: i.name, version: i.version })).files.find((x) => x.path === MANIFEST);
      md.set(`${i.name}@${i.version}`, f ? Buffer.from(f.content_base64, 'base64').toString('utf8') : '');
    }
    const target = items.map((i) => `${i.name} v${i.version}`).join(', ') || NONE;
    return { text: renderRead(ctx.surface, r, (i) => md.get(`${i.name}@${i.version}`) ?? ''), target, result: OK };
  },

  async list_shared_skill_versions(ctx, args) {
    const r = await (await ctx.catalog()).versions(args);
    return { text: renderVersions(ctx.surface, r), target: `${r.name} v${r.latest}`, result: OK };
  },

  async diff_shared_skill_versions(ctx, args) {
    const r = await (await ctx.catalog()).diff(args);
    return { text: renderDiff(ctx.surface, r), target: `${r.name} v${r.from} → v${r.to}`, result: OK };
  },
};

/** Every operation the client runs: the catalog's, and the machine's (machine/index.ts). */
export const RUNS: Record<string, Run> = { ...CATALOG_RUNS, ...MACHINE_RUNS };

/** The line after every result and error while a developer is set (contract §7, "acting as"): data until the
 *  surface words it. */
export const actingAs = (developer: string) => `acting_as: ${developer}`;

/** SKILLS_AS set to something that isn't a developer's name: a setting, which a retry can't fix and only the person
 *  can; data until the surface words it (errors.invalid_developer_setting). */
const INVALID_DEVELOPER_SETTING = 'invalid_developer_setting';

export type Answer = { text: string; isError: boolean };

/** One operation on any face: `op` is the registry's name, `name` what this face calls it (for the log). */
export async function perform(ctx: Context, op: string, name: string, args: unknown): Promise<Answer> {
  const run = RUNS[op];
  if (!run) throw new Error(`no operation ${op}`);
  const { settings } = ctx;
  let done: Done;
  let isError = false;
  if (settings.developerInvalid) {
    done = { text: `${INVALID_DEVELOPER_SETTING}: setting: SKILLS_AS`, target: NONE, result: INVALID_DEVELOPER_SETTING };
    isError = true;
  } else {
    try {
      done = await run(ctx, args);
    } catch (e) {
      const err = toCatalogError(e, settings.home, ctx.now());
      done = { text: renderError(ctx.surface, err), target: NONE, result: err.code };
      isError = true;
    }
  }
  appendActivity(settings.activityLog, { at: ctx.now(), who: settings.developer, tool: name, target: done.target, result: done.result }, { ownFolder: settings.activityLogInHome });
  return { text: settings.developer ? `${done.text}\n${actingAs(settings.developer)}` : done.text, isError };
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
