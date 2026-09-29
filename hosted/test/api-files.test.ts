// A version's files by fingerprint, hosted (contract §1.1): `GET /api/v1/files/<sha256>` serves only a file some stored
// version names. The lookup is written by the indexer seconds after a publish, so the hosted storage tells a file that
// isn't named yet but is on its way (uploaded or claimed under a day ago, bytes that hash to its name, not being
// removed: the route answers 503 with Retry-After: 2) from one that isn't (404). The route itself is the shared handler's.

import { describe, expect, it } from 'vitest';
import { fileState, type FileLookups } from '../src/api/files.ts';
import type { Blob } from '../src/blobs.ts';

const SHA = 'a'.repeat(64);
const NOW = new Date('2026-09-29T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const stored = (ageMs: number, tags: Record<string, string> = {}, matches = true): Blob => ({ kind: 'stored', uploaded: new Date(NOW.getTime() - ageMs), tags, matches });

function lookups(named: boolean, blob: Blob) {
  const asked: string[] = [];
  const p: FileLookups = {
    named: async (s) => (asked.push(`named ${s}`), named),
    inspect: async (s) => (asked.push(`inspect ${s}`), blob),
  };
  return { asked, p };
}

describe('a file by fingerprint, hosted', () => {
  it('a file a version names is named, without looking at the file itself', async () => {
    const { p, asked } = lookups(true, stored(10 * DAY));
    expect(await fileState(SHA, p, NOW)).toBe('named');
    expect(asked).toEqual([`named ${SHA}`]);
  });

  it('not named yet, but uploaded under a day ago and not being removed: on its way', async () => {
    const { p } = lookups(false, stored(DAY - 1000));
    expect(await fileState(SHA, p, NOW)).toBe('on_its_way');
  });

  it('a claim makes an older upload young again', async () => {
    const { p } = lookups(false, stored(3 * DAY, { claimed: new Date(NOW.getTime() - HOUR).toISOString() }));
    expect(await fileState(SHA, p, NOW)).toBe('on_its_way');
  });

  it('not named and a day old or more, marked for removal, bytes not matching its name, or never uploaded: unknown', async () => {
    for (const blob of [stored(DAY), stored(DAY + 1), stored(HOUR, { deleting: NOW.toISOString() }), stored(HOUR, {}, false), { kind: 'absent' } as Blob]) {
      const { p } = lookups(false, blob);
      expect(await fileState(SHA, p, NOW)).toBe('unknown');
    }
  });
});
