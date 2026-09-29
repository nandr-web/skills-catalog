// The read commands (search, read, versions, diff) open the catalog read-only (contract §6): they never create a
// catalog, sweep leftovers or rebuild an index, so pointed at another folder they read or fail, and never write. Setup
// may let an assistant run them without asking, which is safe only because of this.
import { actAs, openCatalog, randomIds, type Surface } from '@skills-catalog/core';
import type { Context } from '../operations.ts';
import type { Settings } from '../settings.ts';

// The core's read-only open (its option lands with the core's round 3; until then the option is ignored and the open
// is today's, which the test for it records as not yet true).
const READ_ONLY = { readOnly: true } as object;

export function readOnlyContext(settings: Settings, surface: Surface, now: () => Date = () => new Date()): { ctx: Context; close: () => void } {
  let opened: ReturnType<typeof openCatalog> | undefined;
  const catalog = () => (opened ??= openCatalog(settings.catalog, { identity: actAs(settings.developer), ...READ_ONLY }));
  const close = () => void opened?.then((c) => c.close()).catch(() => {});
  return { ctx: { catalog, surface, settings, face: 'cli', now, ids: randomIds }, close };
}
