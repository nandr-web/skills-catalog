// Reviews in the local catalog's file (contract §10): their own table beside the versions. A catalog from before it has no
// reviews: a read-only open reads none and writes nothing; the first writing open makes the table. A row that isn't JSON
// (the file is someone else's input, contract §6) reads as no review.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import type { Storage } from '../src/ports.ts';
import type { Review } from '../src/skill-tree/index.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { contents, request } from './helpers.ts';
import { sandbox } from './sandbox.ts';

const histories = loadGolden('histories.yaml');
const NAME = 'pr-review-checklist';
const ana = actAs('ana');
const storageOf = (c: unknown) => (c as { p: { storage: Storage } }).p.storage;

function withDb<T>(root: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(root, 'catalog.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const hasReviews = (root: string) => withDb(root, (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviews'").get() !== undefined);

const review: Review = {
  reviewer: 'security-agent',
  reviewer_version: '1',
  fingerprint: 'sha256:' + 'c'.repeat(64),
  at: '2026-09-28T12:00:00.000Z',
  measurements: { context_tokens: 1 },
  flags: [],
  findings: [],
};

async function published(): Promise<string> {
  const root = join(sandbox(), 'catalog');
  const c = await openLocalCatalog(root);
  await c.publish(request(NAME, historyVersion(histories.versions['prc.v1'])), ana);
  await storageOf(c).putReview(NAME, 1, review);
  c.close();
  return root;
}

describe('reviews in the local catalog file', () => {
  it('a catalog from before the reviews table: a read-only open reads none and writes nothing; a writing open makes it', async () => {
    const root = await published();
    withDb(root, (db) => db.exec('DROP TABLE reviews'));
    const before = contents(root);
    const ro = await openLocalCatalog(root, { readOnly: true });
    expect(await storageOf(ro).reviews(NAME, 1)).toEqual([]);
    ro.close();
    expect(contents(root)).toEqual(before);
    expect(hasReviews(root)).toBe(false);
    (await openLocalCatalog(root)).close();
    expect(hasReviews(root)).toBe(true);
  });

  it('a review row that is not JSON reads as no review; the others still read', async () => {
    const root = await published();
    withDb(root, (db) => db.prepare("INSERT INTO reviews (name, version, reviewer, data) VALUES (?, 1, 'broken', '{not json')").run(NAME));
    const ro = await openLocalCatalog(root, { readOnly: true });
    expect((await storageOf(ro).reviews(NAME, 1)).map((r) => r.reviewer)).toEqual(['security-agent']);
    ro.close();
  });
});
