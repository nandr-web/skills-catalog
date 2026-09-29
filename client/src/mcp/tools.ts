// The catalog's tools on the MCP face: each registry operation that has an MCP tool (contract §2) runs the core's
// operation and puts its result through the core's renderer, so the MCP text and the CLI's output say the same thing.
// Each also says what the activity log shows about it: the target comes from the result (the skills it returned, a
// match count), never from the arguments, which an assistant can fill with anything.
import { MANIFEST, renderDiff, renderRead, renderSearch, renderVersions, type Catalog, type ReadItem, type Surface } from '@skills-catalog/core';

/** Words the client waits for from the agent-facing surface. Until one lands it's shown as data, and a test fails
 *  the moment it appears in the vendored surface, so it gets wired. */
export const CLIENT_WORD_GAPS = ['acting_as', 'log'] as const;

/** What a tool call gives: the text an assistant reads, and the activity log's target and short result. */
export type Done = { text: string; target: string; result: string };
export type Run = (catalog: Catalog, surface: Surface, args: unknown) => Promise<Done>;

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

/** Keyed by the registry's operation name: the tool's name is the surface's. */
export const RUNS: Record<string, Run> = {
  async search_shared_skills(c, s, args) {
    const r = await c.search(args);
    const query = field(args, 'query');
    return { text: renderSearch(s, r, typeof query === 'string' ? query : '', offsetOf(field(args, 'cursor'))), target: `${r.total_matches}/${r.catalog_size}`, result: OK };
  },

  async read_shared_skill(c, s, args) {
    const r = await c.read(args);
    const items = r.skills.filter((e): e is ReadItem => !('error' in e));
    // Each SKILL.md as published, for the renderer (which takes it synchronously).
    const md = new Map<string, string>();
    for (const i of items) {
      const f = (await c.fetch({ name: i.name, version: i.version })).files.find((x) => x.path === MANIFEST);
      md.set(`${i.name}@${i.version}`, f ? Buffer.from(f.content_base64, 'base64').toString('utf8') : '');
    }
    const target = items.map((i) => `${i.name} v${i.version}`).join(', ') || NONE;
    return { text: renderRead(s, r, (i) => md.get(`${i.name}@${i.version}`) ?? ''), target, result: OK };
  },

  async list_shared_skill_versions(c, s, args) {
    const r = await c.versions(args);
    return { text: renderVersions(s, r), target: `${r.name} v${r.latest}`, result: OK };
  },

  async diff_shared_skill_versions(c, s, args) {
    const r = await c.diff(args);
    return { text: renderDiff(s, r), target: `${r.name} v${r.from} → v${r.to}`, result: OK };
  },
};

/** The line after every result and error while a developer is set (contract §7, "acting as"): data until the
 *  surface words it. */
export const actingAs = (developer: string) => `acting_as: ${developer}`;
