// The local catalog: one folder holding the SQLite file and the files by digest (contract §4.5), shared by every
// developer acting on this machine.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Catalog, type CatalogConfig } from '../catalog.ts';
import { CatalogError } from '../errors.ts';
import type { BlobStore, Clock, Ids, MetadataStore } from '../ports.ts';
import { FolderBlobStore } from './blobs.ts';
import { LocalDb } from './db.ts';
import { SqliteMetadataStore } from './metadata.ts';
import { LocalOutbox } from './outbox.ts';
import { SqliteSearchIndex } from './search-index.ts';

export const DB_FILE = 'catalog.sqlite';

export interface LocalOptions {
  clock?: Clock;
  ids?: Ids;
  config?: Partial<CatalogConfig>;
  // Test seams: wrap an adapter (fault injection) without changing the catalog.
  wrapMeta?: (m: MetadataStore) => MetadataStore;
  wrapBlobs?: (b: BlobStore) => BlobStore;
}

export const systemClock: Clock = { now: () => new Date() };
export const randomIds: Ids = { next: () => randomUUID() };

export function openLocalCatalog(dir: string, opts: LocalOptions = {}): Catalog {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clock = opts.clock ?? systemClock;
  const ids = opts.ids ?? randomIds;
  const db = new LocalDb(join(dir, DB_FILE));
  const meta = new SqliteMetadataStore(db);
  const blobs = new FolderBlobStore(dir, ids);
  return new Catalog({
    meta: opts.wrapMeta ? opts.wrapMeta(meta) : meta,
    blobs: opts.wrapBlobs ? opts.wrapBlobs(blobs) : blobs,
    index: new SqliteSearchIndex(db),
    events: new LocalOutbox(db, clock),
    clock,
    ids,
    ...(opts.config ? { config: opts.config } : {}),
    close: () => db.close(),
  });
}

// SKILLS_CATALOG (contract §8): file:///… is the local adapter; https://… is the hosted one (not built in phase 1).
export function openCatalog(url: string, opts: LocalOptions = {}): Catalog {
  if (url.startsWith('file://')) return openLocalCatalog(fileURLToPath(url), opts);
  if (url.startsWith('https://')) throw new CatalogError('forbidden', { catalog: url, why: 'a hosted catalog is not part of this version; use a local folder' });
  throw new CatalogError('invalid_request', { field: 'catalog', why: 'a file:// or https:// URL' });
}
