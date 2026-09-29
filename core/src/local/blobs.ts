// The local storage's blob half (the contract's BlobStore row): a folder of files named by their sha256. Each is
// written to a temp file and renamed into place (contract §7), so a reader never sees half a file, and two processes
// writing the same blob both succeed. Synchronous, used only inside the local Storage adapter (storage.ts).

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, Ids } from '../ports.ts';

const HEX = /^[0-9a-f]{64}$/;

export class FolderBlobStore {
  private readonly dir: string;
  private readonly tmp: string;
  private readonly ids: Ids;
  private readonly clock: Clock;
  private readonly readOnly: boolean;

  // `readOnly` (the read commands' open, contract §6): makes no folder and refuses every write, so nothing reaches the
  // folder even before the database would refuse.
  constructor(root: string, ids: Ids, clock: Clock = { now: () => new Date() }, readOnly = false) {
    this.dir = join(root, 'blobs');
    this.tmp = join(root, 'tmp');
    this.ids = ids;
    this.clock = clock;
    this.readOnly = readOnly;
    if (readOnly) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
  }

  private writable(): void {
    if (this.readOnly) throw new Error('storage: this catalog was opened read-only');
  }

  private path(sha256: string): string {
    if (!HEX.test(sha256)) throw new Error(`not a sha256: ${sha256}`);
    return join(this.dir, sha256.slice(0, 2), sha256.slice(2));
  }

  has(sha256: string): boolean {
    try {
      return statSync(this.path(sha256)).isFile();
    } catch {
      return false;
    }
  }

  delete(sha256: string): void {
    this.writable();
    rmSync(this.path(sha256), { force: true });
  }

  *list(): Iterable<string> {
    if (!existsSync(this.dir)) return;
    for (const prefix of readdirSync(this.dir)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      for (const rest of readdirSync(join(this.dir, prefix))) if (HEX.test(prefix + rest)) yield prefix + rest;
    }
  }

  storedAt(sha256: string): Date | undefined {
    try {
      return statSync(this.path(sha256)).mtime;
    } catch {
      return undefined;
    }
  }

  sweepTemp(before: Date): void {
    this.writable();
    for (const name of readdirSync(this.tmp)) {
      const p = join(this.tmp, name);
      try {
        if (statSync(p).mtime < before) rmSync(p, { force: true });
      } catch {
        // gone already
      }
    }
  }

  // Put-if-absent. A blob that already exists gets its modified time refreshed, so the orphan cleanup (which goes
  // by age) never takes a blob that a publish in flight is about to reference.
  put(sha256: string, bytes: Uint8Array): boolean {
    this.writable();
    const final = this.path(sha256);
    const now = this.clock.now();
    if (this.has(sha256)) {
      try {
        utimesSync(final, now, now);
        return false;
      } catch {
        // removed between the check and the touch: write it again below
      }
    }
    mkdirSync(join(this.dir, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    const temp = join(this.tmp, `${sha256}.${process.pid}.${this.ids.next()}`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    utimesSync(temp, now, now);
    try {
      renameSync(temp, final);
    } catch (e) {
      rmSync(temp, { force: true });
      throw e;
    }
    return true;
  }

  get(sha256: string): Uint8Array | undefined {
    try {
      return readFileSync(this.path(sha256));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  }
}
