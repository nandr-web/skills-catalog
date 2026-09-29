// Storage tests (golden/histories.yaml `concurrent` and `fault`): a refused or failed publish leaves no version behind,
// and no version ever points at a missing blob. The ports' shared tests run on every adapter (test/shared/storage.ts);
// these are the local adapter's own (the open-time cleanup of publishes that didn't finish, the blob put back under its
// lock). Nothing lost across processes is in storage-processes.test.ts.

import { createHash } from 'node:crypto';
import { readdirSync, rmSync, utimesSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Storage } from '../src/ports.ts';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import { FolderBlobStore } from '../src/local/blobs.ts';
import type { SqliteMetadataStore } from '../src/local/metadata.ts';
import { ADAPTERS } from './adapters.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { counterIds, errorOf, fixedClock, openTest, request, versionsIn } from './helpers.ts';
import { sandbox } from './sandbox.ts';
import { storageSuite } from './shared/storage.ts';

const histories = loadGolden('histories.yaml');
const ana = actAs('ana');

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function storedBlobs(dir: string): Set<string> {
  return new Set(
    readdirSync(join(dir, 'catalog', 'blobs'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => basename(d.parentPath) + d.name),
  );
}

// Another publish lands just before this catalog's next commit (after its pre-checks).
function raceBeforeCommit(rival: () => Promise<void>): (s: Storage) => Storage {
  let armed = true;
  return (s) =>
    Object.assign(Object.create(s), {
      commit: async (...args: Parameters<Storage['commit']>) => {
        if (armed) {
          armed = false;
          await rival();
        }
        return s.commit(...args);
      },
    });
}

for (const a of ADAPTERS) storageSuite(a);

describe('fault injection (histories.fault)', () => {
  // The open-time cleanup reads only the publishes that didn't finish (their pending rows), never the blob folder
  // (contract §5.1). A crash is a publish whose error handling never ran: here, its take-back fails too.
  const crashing = (at: 'put' | 'append') => {
    const state = { crashed: false };
    const crash = () => {
      state.crashed = true;
      throw new Error(`injected crash at ${at}`);
    };
    return {
      state,
      opts: {
        wrapMeta: (m: SqliteMetadataStore) =>
          Object.assign(Object.create(m), {
            append: (...a: Parameters<SqliteMetadataStore['append']>) => (at === 'append' ? crash() : m.append(...a)),
            withWriteLock: <T,>(fn: () => T): T => {
              if (state.crashed) throw new Error('the process is gone');
              return m.withWriteLock(fn);
            },
          }),
        wrapBlobs: (b: FolderBlobStore) => Object.assign(Object.create(b), { put: (s: string, bytes: Uint8Array) => (at === 'put' ? crash() : b.put(s, bytes)) }),
      },
    };
  };
  const later = (minutes: number) => ({ now: () => new Date(Date.now() + minutes * 60_000) });
  const pendingRows = (dir: string) => {
    const db = new DatabaseSync(join(dir, 'catalog', 'catalog.sqlite'), { readOnly: true });
    try {
      return (db.prepare('SELECT sha256 FROM pending_blobs ORDER BY sha256').all() as { sha256: string }[]).map((r) => r.sha256);
    } finally {
      db.close();
    }
  };

  it('a publish that crashed after storing its files: cleaned at an open over an hour later, not before; a file a version shares is kept', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    const first = await openLocalCatalog(root);
    const v1 = historyVersion(histories.versions['prc.v1']);
    await first.publish(request('pr-review-checklist', v1), ana);
    first.close();
    const crashed = crashing('append');
    const c = await openLocalCatalog(root, crashed.opts);
    const shared = v1[0]!;
    const orphan = { path: 'notes/crash.md', mode: '0644' as const, bytes: Buffer.from('left by a crash\n') };
    await expect(c.publish(request('pr-review-checklist', [...v1, orphan]), ana)).rejects.toThrow(/injected crash/);
    c.close();
    expect(storedBlobs(dir).has(sha(orphan.bytes))).toBe(true);
    expect(pendingRows(dir)).toEqual([sha(orphan.bytes)]); // the shared file was stored already: no row for it
    (await openLocalCatalog(root, { clock: later(59) })).close();
    expect([storedBlobs(dir).has(sha(orphan.bytes)), pendingRows(dir)]).toEqual([true, [sha(orphan.bytes)]]);
    (await openLocalCatalog(root, { clock: later(61) })).close();
    expect([storedBlobs(dir).has(sha(orphan.bytes)), storedBlobs(dir).has(sha(shared.bytes)), pendingRows(dir)]).toEqual([false, true, []]);
    const reopened = await openLocalCatalog(root, { clock: later(24 * 60) });
    expect((await reopened.fetch({ name: 'pr-review-checklist', version: 1 })).files).toHaveLength(2);
    reopened.close();
  });

  it('a publish that crashed before writing its files leaves only rows: cleared an hour later, nothing else touched', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    const crashed = crashing('put');
    const c = await openLocalCatalog(root, crashed.opts);
    await expect(c.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana)).rejects.toThrow(/injected crash/);
    c.close();
    expect(pendingRows(dir)).toHaveLength(2);
    expect(storedBlobs(dir).size).toBe(0);
    (await openLocalCatalog(root, { clock: later(61) })).close();
    expect([pendingRows(dir), storedBlobs(dir).size]).toEqual([[], 0]);
  });

  it('a publish in flight in another process is never touched by an open\'s cleanup', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    (await openLocalCatalog(root)).close();
    // The other process: its files stored and marked a minute ago, its version not appended yet.
    const blobs = new FolderBlobStore(root, counterIds());
    const db = new DatabaseSync(join(root, 'catalog.sqlite'));
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    for (const f of historyVersion(histories.versions['prc.v1'])) {
      db.prepare('INSERT INTO pending_blobs (sha256, at) VALUES (?, ?)').run(sha(f.bytes), minuteAgo);
      blobs.put(sha(f.bytes), f.bytes);
    }
    db.close();
    (await openLocalCatalog(root)).close();
    expect([storedBlobs(dir).size, pendingRows(dir).length]).toEqual([2, 2]);
  });

  it('a stale row for a file a version references clears the row and keeps the file', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    const first = await openLocalCatalog(root);
    const v1 = historyVersion(histories.versions['prc.v1']);
    await first.publish(request('pr-review-checklist', v1), ana);
    first.close();
    const db = new DatabaseSync(join(root, 'catalog.sqlite'));
    db.prepare('INSERT INTO pending_blobs (sha256, at) VALUES (?, ?)').run(sha(v1[0]!.bytes), new Date(Date.now() - 2 * 3600_000).toISOString());
    db.close();
    (await openLocalCatalog(root)).close();
    expect([pendingRows(dir), storedBlobs(dir).has(sha(v1[0]!.bytes))]).toEqual([[], true]);
  });

  it('a leftover from before publishes were marked stays: the cleanup never walks the blob folder', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    (await openLocalCatalog(root)).close();
    const orphan = Buffer.from('left before the rows existed\n');
    const blobs = new FolderBlobStore(root, counterIds());
    blobs.put(sha(orphan), orphan);
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(join(root, 'blobs', sha(orphan).slice(0, 2), sha(orphan).slice(2)), old, old);
    (await openLocalCatalog(root, { clock: later(24 * 60) })).close();
    expect(blobs.has(sha(orphan))).toBe(true);
  });

  it('a catalog from before the table gets it at its first writing open; a read-only open works without it', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    const first = await openLocalCatalog(root);
    await first.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana);
    first.close();
    const db = new DatabaseSync(join(root, 'catalog.sqlite'));
    db.exec('DROP TABLE pending_blobs');
    db.close();
    const ro = await openLocalCatalog(root, { readOnly: true });
    expect((await ro.versions({ name: 'pr-review-checklist' })).latest).toBe(1);
    ro.close();
    const w = await openLocalCatalog(root);
    expect(await w.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v2'])), ana)).toMatchObject({ created: true, version: 2 });
    w.close();
    expect(pendingRows(dir)).toEqual([]);
  });

  it('a publish refused at its commit point leaves no pending row; a created one clears its rows', async () => {
    const dir = sandbox();
    const { catalog } = await openTest(
      {
        wrapStorage: raceBeforeCommit(async () => {
          const bo = await openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds() });
          await bo.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), actAs('bo'));
          bo.close();
        }),
      },
      dir,
    );
    expect((await errorOf(() => catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v3'])), ana))).code).toBe('not_owner');
    expect(pendingRows(dir)).toEqual([]);
    await catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), ana);
    expect(pendingRows(dir)).toEqual([]);
    catalog.close();
  });

  it('a blob cleaned away between the put and the commit is put back under the lock: no version points at a missing blob', async () => {
    const dir = sandbox();
    let armed = false;
    let swept = false;
    const { catalog } = await openTest(
      {
        wrapMeta: (m: SqliteMetadataStore) =>
          Object.assign(Object.create(m), {
            withWriteLock: <T,>(fn: () => T): T => {
              if (armed && !swept) {
                swept = true; // an over-eager cleanup in another process, just before this commit
                rmSync(join(dir, 'catalog', 'blobs'), { recursive: true, force: true });
              }
              return m.withWriteLock(fn);
            },
          }),
      },
      dir,
    );
    armed = true;
    expect(await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana)).toMatchObject({ created: true, version: 1 });
    expect(swept).toBe(true);
    expect((await catalog.fetch({ name: 'pr-review-checklist', version: 1 })).files).toHaveLength(2);
  });

  it('if putting the missing blob back fails too, no version is stored, and a retry lands', async () => {
    const dir = sandbox();
    let phase: 'open' | 'armed' | 'failing' | 'done' = 'open';
    const { catalog } = await openTest(
      {
        wrapMeta: (m: SqliteMetadataStore) =>
          Object.assign(Object.create(m), {
            withWriteLock: <T,>(fn: () => T): T => {
              if (phase === 'armed') {
                phase = 'failing';
                rmSync(join(dir, 'catalog', 'blobs'), { recursive: true, force: true });
              }
              return m.withWriteLock(fn);
            },
          }),
        wrapBlobs: (b: FolderBlobStore) =>
          Object.assign(Object.create(b), {
            put: (s: string, bytes: Uint8Array) => {
              if (phase === 'failing') {
                phase = 'done';
                throw new Error('injected: re-put failed');
              }
              return b.put(s, bytes);
            },
          }),
      },
      dir,
    );
    phase = 'armed';
    const v1 = historyVersion(histories.versions['prc.v1']);
    await expect(catalog.publish(request('pr-review-checklist', v1), ana)).rejects.toThrow(/re-put failed/);
    expect(versionsIn(dir, 'pr-review-checklist')).toEqual([]);
    expect(await catalog.publish(request('pr-review-checklist', v1), ana)).toMatchObject({ created: true, version: 1 });
    expect((await catalog.fetch({ name: 'pr-review-checklist', version: 1 })).files).toHaveLength(2);
  });

  it('putting a blob that already exists refreshes its time, so the age-based cleanup spares it', () => {
    const root = join(sandbox(), 'catalog');
    const blobs = new FolderBlobStore(root, counterIds());
    const bytes = Buffer.from('shared\n');
    blobs.put(sha(bytes), bytes);
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(root, 'blobs', sha(bytes).slice(0, 2), sha(bytes).slice(2)), old, old);
    expect(blobs.put(sha(bytes), bytes)).toBe(false);
    expect(blobs.storedAt(sha(bytes))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });
});
