// Storage, local adapter: SQLite for versions and a folder for blobs, kept consistent by one write lock (SQLite's
// BEGIN IMMEDIATE, shared by every process on the folder). The publish's commit point, taking back a refused
// publish's blobs, and the open-time cleanup of orphan blobs all live here, under that lock (contract §5.1).

import type { Clock, CommitResult, FileState, NewVersion, SkillRecord, Storage, VersionPublished, VersionRecord } from '../ports.ts';
import type { FolderBlobStore } from './blobs.ts';
import type { SqliteMetadataStore } from './metadata.ts';

const COMMIT_TRIES = 5;
export const ORPHAN_AGE_MS = 60 * 60 * 1000;

export class LocalStorage implements Storage {
  private readonly meta: SqliteMetadataStore;
  private readonly blobs: FolderBlobStore;
  private readonly clock: Clock;

  constructor(meta: SqliteMetadataStore, blobs: FolderBlobStore, clock: Clock) {
    this.meta = meta;
    this.blobs = blobs;
    this.clock = clock;
  }

  async skill(name: string): Promise<SkillRecord | undefined> {
    return this.meta.skill(name);
  }

  async version(name: string, version: number): Promise<VersionRecord | undefined> {
    return this.meta.version(name, version);
  }

  async byFingerprint(fingerprint: string): Promise<VersionRecord | undefined> {
    return this.meta.byFingerprint(fingerprint);
  }

  async versions(name: string, offset: number, limit: number): Promise<VersionRecord[]> {
    return this.meta.versions(name, offset, limit);
  }

  async latestVersions(): Promise<VersionRecord[]> {
    return this.meta.latestVersions();
  }

  async names(): Promise<string[]> {
    return this.meta.names();
  }

  async count(): Promise<number> {
    return this.meta.count();
  }

  async blob(sha256: string): Promise<Uint8Array | undefined> {
    return this.blobs.get(sha256);
  }

  async fileState(sha256: string): Promise<FileState> {
    return this.meta.referencesBlob(sha256) ? 'named' : 'unknown';
  }

  async commit(
    v: NewVersion,
    files: readonly { sha256: string; bytes: Uint8Array }[],
    cond: { expectedLatest?: number | undefined },
    event: (version: number) => VersionPublished,
  ): Promise<CommitResult> {
    // The files not stored yet are marked pending first, in their own short transaction, so a crash from here on
    // leaves rows the open-time cleanup reads, never an unmarked file.
    const fresh = [...new Set(files.filter((f) => !this.blobs.has(f.sha256)).map((f) => f.sha256))];
    if (fresh.length) this.meta.markPending(fresh, this.clock.now().toISOString());
    const added = new Set<string>();
    for (const f of files) if (this.blobs.put(f.sha256, f.bytes)) added.add(f.sha256);
    // A refused or failed commit takes back the blobs it added that no version references, and its pending rows,
    // under the lock, so storage is exactly as it was even when another publish won the race.
    const takeBack = () => {
      try {
        this.meta.withWriteLock(() => {
          for (const sha of added) if (!this.meta.referencesBlob(sha)) this.blobs.delete(sha);
          this.meta.clearPending([...fresh, ...added]);
        });
      } catch {
        // Left for the open-time cleanup: their pending rows stay, and no version points at them.
      }
    };
    for (let attempt = 1; ; attempt++) {
      let r: CommitResult;
      try {
        // Under the same lock as the cleanup, every blob this version references must exist: one cleaned away
        // (a stalled publish, a raced take-back) is put again from the bytes held here. If that fails, the
        // publish fails, retryable, with no version stored.
        r = this.meta.withWriteLock(() => {
          for (const f of files) if (!this.blobs.has(f.sha256) && this.blobs.put(f.sha256, f.bytes)) added.add(f.sha256);
          const out = this.meta.append(v, cond, event);
          if (out.kind === 'created') this.meta.clearPending(files.map((f) => f.sha256));
          return out;
        });
      } catch (e) {
        if (attempt < COMMIT_TRIES && /busy|locked/i.test(String((e as Error).message))) continue;
        takeBack();
        throw e;
      }
      if (r.kind !== 'created') takeBack();
      return r;
    }
  }

  // After a publish that failed part-way (a crash, a full disk), its pending rows remain. Reads only those marked over
  // an hour ago by the clock, so another process's publish in flight is never touched: removes each one's file unless
  // a version references it, and clears the row. Never walks the blob folder (contract §5.1); a leftover from before
  // publishes were marked stays, unreferenced and unseen. Runs when the catalog is opened for writing.
  sweep(maxAgeMs = ORPHAN_AGE_MS): number {
    const before = new Date(this.clock.now().getTime() - maxAgeMs);
    let removed = 0;
    this.meta.withWriteLock(() => {
      const stale = this.meta.pendingBefore(before.toISOString());
      for (const sha of stale) {
        if (!this.meta.referencesBlob(sha) && this.blobs.has(sha)) {
          this.blobs.delete(sha);
          removed++;
        }
      }
      this.meta.clearPending(stale);
    });
    this.blobs.sweepTemp(before);
    return removed;
  }
}
