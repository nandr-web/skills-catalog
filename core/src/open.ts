// SKILLS_CATALOG (contract §8): file:///… is the local adapter; https://… is a hosted catalog, reached over its web API
// with the person's token (remote/index.ts).

import { fileURLToPath } from 'node:url';
import type { Catalog } from './catalog.ts';
import { CatalogError } from './errors.ts';
import { openLocalCatalog, type LocalOptions } from './local/index.ts';
import { openRemoteCatalog, type RemoteOptions } from './remote/index.ts';

export async function openCatalog(url: string, opts: LocalOptions & RemoteOptions = {}): Promise<Catalog> {
  if (url.startsWith('file://')) return openLocalCatalog(fileURLToPath(url), opts);
  if (url.startsWith('https://')) return openRemoteCatalog(url, opts);
  throw new CatalogError('invalid_request', { field: 'catalog', why: 'not_a_catalog_url' });
}
