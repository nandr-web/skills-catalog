// The adapters the shared suites run on (test/shared/): each gives a fresh store that one or more catalogs open, and
// reads what the store holds straight from it (never through the catalog), so a suite's oracles are the same for every
// adapter. Another adapter is one more line in ADAPTERS.

import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Catalog, CatalogConfig } from '../src/catalog.ts';
import type { Clock, Identity, Ids, Storage } from '../src/ports.ts';
import { openLocalCatalog } from '../src/local/index.ts';
import type { SqliteMetadataStore } from '../src/local/metadata.ts';
import { counterIds, fixedClock, snapshot, versionsIn } from './helpers.ts';
import { sandbox } from './sandbox.ts';

export interface StoreOptions {
  clock?: Clock;
  ids?: Ids;
  identity?: Identity;
  config?: Partial<CatalogConfig>;
  /** Wraps the Storage port the catalog uses (another publish landing just before this one's commit). */
  wrapStorage?: (s: Storage) => Storage;
  /** The next commit fails with this error after the files are stored and before the version is recorded. */
  failNextAppend?: Error;
}

/** One catalog's storage, opened by any number of catalogs (a rival publish opens its own). */
export interface TestStore {
  /** A catalog on this store; the clock and ids default to a fixed clock and counted ids. */
  open(opts?: StoreOptions): Promise<Catalog>;
  /** Every stored file's sha256. */
  blobs(): Promise<Set<string>>;
  /** A skill's stored version numbers, oldest first. */
  versionsIn(name: string): Promise<number[]>;
  /** Everything stored (records, events, search cards, files), for "storage is exactly as it was". */
  snapshot(): Promise<string>;
}

export interface TestAdapter {
  name: string;
  /** A refused commit removes the files it added (local); an adapter that can't delete leaves them unreferenced for its
   *  sweep (hosted), so the suites check exact file sets only where this is true. */
  takesBackRefusedFiles: boolean;
  store(): TestStore;
}

/** A catalog on a fresh store, and the store. */
export async function openOn(a: TestAdapter, opts: StoreOptions = {}): Promise<{ store: TestStore; catalog: Catalog }> {
  const store = a.store();
  return { store, catalog: await store.open(opts) };
}

export const localAdapter: TestAdapter = {
  name: 'local',
  takesBackRefusedFiles: true,
  store() {
    const dir = sandbox();
    return {
      open: ({ failNextAppend, ...opts } = {}) => {
        let fail = failNextAppend;
        const wrapMeta = fail
          ? (m: SqliteMetadataStore) =>
              Object.assign(Object.create(m), {
                append: (...args: Parameters<SqliteMetadataStore['append']>) => {
                  if (fail) {
                    const e = fail;
                    fail = undefined;
                    throw e;
                  }
                  return m.append(...args);
                },
              })
          : undefined;
        return openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds(), ...opts, ...(wrapMeta ? { wrapMeta } : {}) });
      },
      blobs: async () =>
        new Set(
          readdirSync(join(dir, 'catalog', 'blobs'), { recursive: true, withFileTypes: true })
            .filter((d) => d.isFile())
            .map((d) => basename(d.parentPath) + d.name),
        ),
      versionsIn: async (name) => versionsIn(dir, name),
      snapshot: async () => snapshot(dir),
    };
  },
};

export const ADAPTERS: readonly TestAdapter[] = [localAdapter];
