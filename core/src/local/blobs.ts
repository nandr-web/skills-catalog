// BlobStore, local adapter: a folder of files named by their sha256. Each is written to a temp file and renamed into
// place (contract §7), so a reader never sees half a file, and two processes writing the same blob both succeed.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { BlobStore, Ids } from '../ports.ts';

const HEX = /^[0-9a-f]{64}$/;

export class FolderBlobStore implements BlobStore {
  private readonly dir: string;
  private readonly tmp: string;
  private readonly ids: Ids;

  constructor(root: string, ids: Ids) {
    this.dir = join(root, 'blobs');
    this.tmp = join(root, 'tmp');
    this.ids = ids;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.tmp, { recursive: true, mode: 0o700 });
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

  put(sha256: string, bytes: Uint8Array): void {
    const final = this.path(sha256);
    if (this.has(sha256)) return;
    mkdirSync(join(this.dir, sha256.slice(0, 2)), { recursive: true, mode: 0o700 });
    const temp = join(this.tmp, `${sha256}.${process.pid}.${this.ids.next()}`);
    const fd = openSync(temp, 'wx', 0o600);
    try {
      writeSync(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temp, final);
    } catch (e) {
      rmSync(temp, { force: true });
      throw e;
    }
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
