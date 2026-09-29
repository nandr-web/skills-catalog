// The read commands (search, read, versions, diff) open the catalog read-only (contract §6): they never create a
// catalog, sweep leftovers or rebuild an index, so pointed at another folder they read or fail, and never write. Setup
// may let an assistant run them without asking, which is safe only because of this. With no catalog at the default place
// yet they answer as an empty one; a catalog named with SKILLS_CATALOG that isn't there is `not_a_catalog`, so a
// mistyped path is never taken for an empty catalog.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { actAs, openCatalog, randomIds, type Words } from '@skills-catalog/core';
import type { Context } from '../operations.ts';
import type { Settings } from '../settings.ts';

export function readOnlyContext(settings: Settings, words: Words, now: () => Date = () => new Date()): { ctx: Context; close: () => void } {
  let opened: ReturnType<typeof openCatalog> | undefined;
  // Named: anything but the default place, $SKILLS_HOME/catalog.
  const named = settings.catalog !== pathToFileURL(join(settings.home, 'catalog')).href;
  const catalog = () => (opened ??= openCatalog(settings.catalog, { identity: actAs(settings.developer), readOnly: true, named }));
  const close = () => void opened?.then((c) => c.close()).catch(() => {});
  return { ctx: { catalog, words, settings, face: 'cli', now, ids: randomIds }, close };
}
