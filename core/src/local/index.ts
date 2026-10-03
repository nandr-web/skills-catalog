// The local catalog: one folder holding the SQLite file and the files by digest (contract §4.5), shared by every
// developer acting on this machine.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Catalog, type CatalogConfig } from '../catalog.ts';
import { CatalogError } from '../errors.ts';
import type { Clock, Events, Identity, Ids, Storage } from '../ports.ts';
import type { Reviewer } from '../skill-tree/index.ts';
import { FolderBlobStore } from './blobs.ts';
import { LocalDb, NotCatalogTables, openReadOnly } from './db.ts';
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
  // The reviewers a publish runs (contract §10); absent, the built-in rules reviewer.
  reviewers?: readonly Reviewer[];
  // Test seams, without changing the catalog: wrap the local storage's halves (fault injection, a cleanup between
  // the blob puts and the append), or the whole Storage port (another publish landing before this one's commit).
  wrapMeta?: (m: SqliteMetadataStore) => SqliteMetadataStore;
  wrapBlobs?: (b: FolderBlobStore) => FolderBlobStore;
  wrapStorage?: (s: Storage) => Storage;
  // The read commands' open (contract §6): the catalog as it is, never created, swept, delivered or re-indexed, and never
  // written. With no catalog file, `named` (SKILLS_CATALOG or --catalog named the place) refuses with not_a_catalog, so a
  // mistyped path isn't read as an empty catalog; at the default place it reads as an empty one.
  readOnly?: boolean;
  named?: boolean;
  // Test seam for the read-only open: runs right before its last check for a -wal file (db.ts openReadOnly).
  beforeImmutable?: () => void;
  // Test seam for the writing open: runs right after an older catalog's table of which versions name a file is filled.
  afterFileIndex?: () => void;
}

export const systemClock: Clock = { now: () => new Date() };
// How long a catalog from before reviews may spend on its first writing open reviewing each skill's latest version.
export const FIRST_REVIEW_MS = 5_000;
export const randomIds: Ids = { next: () => randomUUID() };

// A read-only catalog delivers nothing: pending events wait for the next writing open.
const NO_EVENTS: Events = { subscribe: () => {}, deliver: async () => 0 };

// The read-only open's database: the catalog file as it is; with none, an empty catalog in memory at the default place.
function readOnlyDb(dir: string, opts: LocalOptions): LocalDb {
  const file = join(dir, DB_FILE);
  if (!existsSync(file)) {
    if (opts.named) throw new CatalogError('invalid_request', { field: 'catalog', why: 'not_a_catalog', path: dir });
    const empty = new LocalDb(':memory:');
    empty.db.exec('PRAGMA query_only = ON');
    return empty;
  }
  try {
    return new LocalDb(openReadOnly(file, opts.beforeImmutable));
  } catch (e) {
    throw unreadable(dir, e);
  }
}

// A catalog that can't be opened: its path and, from SQLite, its error code, never its message (contract §6).
function unreadable(dir: string, e: unknown): CatalogError {
  const code = (e as { errcode?: unknown }).errcode;
  return new CatalogError('invalid_request', { field: 'catalog', why: 'catalog_unreadable', path: dir, ...(typeof code === 'number' ? { sqlite_code: code } : {}) });
}

// The writing open's database; a file whose tables aren't the catalog's own is refused like an unreadable one.
function writingDb(dir: string, opts: LocalOptions): LocalDb {
  try {
    return new LocalDb(join(dir, DB_FILE), opts.afterFileIndex ? { afterFileIndex: opts.afterFileIndex } : {});
  } catch (e) {
    if (e instanceof NotCatalogTables) throw unreadable(dir, e);
    throw e;
  }
}

export async function openLocalCatalog(dir: string, opts: LocalOptions = {}): Promise<Catalog> {
  const readOnly = opts.readOnly === true;
  if (!readOnly) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const clock = opts.clock ?? systemClock;
  const ids = opts.ids ?? randomIds;
  const db = readOnly ? readOnlyDb(dir, opts) : writingDb(dir, opts);
  const meta = new SqliteMetadataStore(db);
  const blobs = new FolderBlobStore(dir, ids, clock, readOnly);
  const storage = new LocalStorage(opts.wrapMeta ? opts.wrapMeta(meta) : meta, opts.wrapBlobs ? opts.wrapBlobs(blobs) : blobs, clock);
  try {
    if (!readOnly) storage.sweep();
    const catalog = await Catalog.open({
      where: 'local',
      storage: opts.wrapStorage ? opts.wrapStorage(storage) : storage,
      index: new SqliteSearchIndex(db),
      events: readOnly ? NO_EVENTS : new LocalOutbox(db, clock),
      identity: opts.identity ?? actAs(undefined),
      clock,
      ids,
      ...(opts.config ? { config: opts.config } : {}),
      ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
      close: () => db.close(),
    });
    if (db.indexReset) await catalog.rebuildIndex();
    // A catalog from before reviews were kept: each skill's latest version is reviewed once, now, so its card and its read
    // agree (older versions are the review command's). Best effort and time-bounded: what's left is reviewed by
    // `skills-catalog review`, and read works a missing review out meanwhile.
    if (db.reviewsAdded) {
      try {
        await catalog.reviewStored({ latestOnly: true, deadline: performance.now() + FIRST_REVIEW_MS });
      } catch {
        // left for the review command
      }
    }
    return catalog;
  } catch (e) {
    db.close();
    throw e;
  }
}

export { actAs } from './identity.ts';
export { LocalStorage, ORPHAN_AGE_MS } from './storage.ts';
