// SKILLS_CATALOG (contract §8): file:///… is the local adapter; https://… is the hosted one (not built in phase 1).

import { fileURLToPath } from 'node:url';
import type { Catalog } from './catalog.ts';
import { CatalogError } from './errors.ts';
import { openLocalCatalog, type LocalOptions } from './local/index.ts';

export async function openCatalog(url: string, opts: LocalOptions = {}): Promise<Catalog> {
  if (url.startsWith('file://')) return openLocalCatalog(fileURLToPath(url), opts);
  if (url.startsWith('https://')) throw new CatalogError('forbidden', { catalog: url, why: 'hosted_not_available' });
  throw new CatalogError('invalid_request', { field: 'catalog', why: 'not_a_catalog_url' });
}
