// A version's files by fingerprint, hosted (contract §1.1): the route serves only a file some stored version names. The
// hosted lookup trails a publish by seconds (the indexer writes it), so a file not named yet but uploaded or claimed
// under a day ago, whose bytes hash to its name and which isn't being removed, is on its way (the route answers 503 with
// Retry-After: 2); every other unnamed file is unknown (404).

import { committable, type Blob } from '../blobs.ts';

export type FileLookups = {
  /** Does any stored version name this file (the indexer's item). */
  named(sha256: string): Promise<boolean>;
  inspect(sha256: string): Promise<Blob>;
};

export type FileState = 'named' | 'on_its_way' | 'unknown';

export async function fileState(sha256: string, p: FileLookups, now: Date): Promise<FileState> {
  if (await p.named(sha256)) return 'named';
  return committable(await p.inspect(sha256), now) ? 'on_its_way' : 'unknown';
}
