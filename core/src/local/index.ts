// The local catalog: one folder holding the SQLite file and the files by digest (contract §4.5), shared by every
// developer acting on this machine.

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Catalog, type CatalogConfig } from '../catalog.ts';
import type { Clock, Identity, Ids, Storage } from '../ports.ts';
import { FolderBlobStore } from './blobs.ts';
import { LocalDb } from './db.ts';
import { actAs } from './identity.ts';
import { SqliteMetadataStore } from './metadata.ts';
import { LocalOutbox } from './outbox.ts';
import { SqliteSearchIndex } from './search-index.ts';
import { LocalStorage } from './storage.ts';

export const DB_FILE = 'catalog.sqlite';

export interface LocalOptions {
  clock?: Clock;
  ids?: Ids;
  identity?: Identity;
  config?: Partial<CatalogConfig>;
  // Test seams, without changing the catalog: wrap the local storage's halves (fault injection, a cleanup between
  // the blob puts and the append), or the whole Storage port (another publish landing before this one's commit).
  wrapMeta?: (m: SqliteMetadataStore) => SqliteMetadataStore;
  wrapBlobs?: (b: FolderBlobStore) => FolderBlobStore;
  wrapStorage?: (s: Storage) => Storage;
}

export const systemClock: Clock = { now: () => new Date() };
export const randomIds: Ids = { next: () => randomUUID() };

export async function openLocalCatalog(dir: string, opts: LocalOptions = {}): Promise<Catalog> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clock = opts.clock ?? systemClock;
  const ids = opts.ids ?? randomIds;
  const db = new LocalDb(join(dir, DB_FILE));
  const meta = new SqliteMetadataStore(db);
  const blobs = new FolderBlobStore(dir, ids, clock);
  const storage = new LocalStorage(opts.wrapMeta ? opts.wrapMeta(meta) : meta, opts.wrapBlobs ? opts.wrapBlobs(blobs) : blobs, clock);
  try {
    storage.sweep();
    const catalog = await Catalog.open({
      storage: opts.wrapStorage ? opts.wrapStorage(storage) : storage,
      index: new SqliteSearchIndex(db),
      events: new LocalOutbox(db, clock),
      identity: opts.identity ?? actAs(undefined),
      clock,
      ids,
      ...(opts.config ? { config: opts.config } : {}),
      close: () => db.close(),
    });
    if (db.indexReset) await catalog.rebuildIndex();
    return catalog;
  } catch (e) {
    db.close();
    throw e;
  }
}

export { actAs } from './identity.ts';
export { LocalStorage, ORPHAN_AGE_MS } from './storage.ts';
