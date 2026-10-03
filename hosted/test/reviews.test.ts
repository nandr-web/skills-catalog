// Reviews, hosted (contract §10): one DynamoDB item per reviewer of a version. A review at its largest (every finding at
// REVIEW_LIMITS, every text at its longest) still fits an item (DynamoDB: 400 KB, its keys included); an item that can't be
// read is skipped, as the local adapter skips a row that isn't JSON.

import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { boundOutcome, REVIEW_LIMITS, type Review } from '@skills-catalog/core/skill-tree';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStores, HostedStorage, type Place } from '../src/index.ts';
import { reviewKey } from '../src/place.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

const DYNAMODB_ITEM_BYTES = 400 * 1024;

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

let n = 0;
async function world() {
  const place: Place = { table: `reviews-${++n}`, bucket: `reviews-${n}` };
  const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
  const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  await createStores(ddb, s3, place);
  return { ddb, place, storage: new HostedStorage({ ddb, s3, place, clock: { now: () => new Date() } }) };
}

// Every text at its longest: 200 code points of 4-byte characters, and quotes and backslashes JSON doubles.
const longest = (i: number) => `${i}"\\${'\u{1d54f}'.repeat(400)}`;

function largestReview(): Review {
  const findings = Array.from({ length: 200 }, (_, i) => ({ kind: 'prompt_injection' as const, path: longest(i % 10), line: i + 1, evidence: longest(i), why: longest(i) }));
  const flags = findings.map((f) => ({ kind: f.kind, path: f.path, line: f.line, field: longest(f.line), from: { big: longest(1).repeat(10) }, to: longest(2), detail: longest(3) }));
  const measurements = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [longest(i), i]));
  const o = boundOutcome({ measurements, flags, findings, notes: longest(0).repeat(100) });
  return { reviewer: 'r'.repeat(64), reviewer_version: '1', fingerprint: 'sha256:' + 'a'.repeat(64), at: '2026-10-03T00:00:00.000Z', ...o };
}

describe('reviews, hosted', () => {
  it('a review at its largest fits one DynamoDB item, and reads back whole', async () => {
    const { storage } = await world();
    const r = largestReview();
    expect(r.findings).toHaveLength(REVIEW_LIMITS.findings);
    const json = Buffer.byteLength(JSON.stringify(r));
    expect(json).toBeLessThan(REVIEW_LIMITS.bytes);
    expect(REVIEW_LIMITS.bytes + 1024).toBeLessThan(DYNAMODB_ITEM_BYTES);
    await storage.putReview('big-skill', 1, r);
    expect(await storage.reviews('big-skill', 1)).toEqual([r]);
  });

  it('an item that isn\'t a review\'s JSON is skipped; the others read', async () => {
    const { ddb, place, storage } = await world();
    const good = { ...largestReview(), reviewer: 'rules' };
    await storage.putReview('some-skill', 1, good);
    const { pk, sk } = reviewKey('some-skill', 1, 'broken');
    await ddb.send(new PutItemCommand({ TableName: place.table, Item: { pk: { S: pk }, sk: { S: sk }, data: { S: '{not json' } } }));
    await ddb.send(new PutItemCommand({ TableName: place.table, Item: { pk: { S: pk }, sk: { S: `${sk}-no-data` } } }));
    expect((await storage.reviews('some-skill', 1)).map((r) => r.reviewer)).toEqual(['rules']);
  });
});
