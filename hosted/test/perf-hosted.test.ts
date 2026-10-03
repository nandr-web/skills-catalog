// `npm run perf` (scripts/perf-hosted.ts, review P15.2) kept working: on a small search file against the stand-in it
// times a fresh instance's first search and warm searches, and reports them labelled as emulator numbers.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostedTimes, report, scaleCards } from '../scripts/perf-hosted.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

describe('the hosted perf script', () => {
  it('times first and warm searches on the stand-in, labelled as emulator numbers', async () => {
    const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
    const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
    const cards = await scaleCards(80);
    expect(cards).toHaveLength(80);
    const t = await hostedTimes({ ddb, s3, place: { table: 'perf-test', bucket: 'perf-test' }, cards, terms: ['release notes'], calls: 4, colds: 2 });
    expect([t.first.length, t.warm.length]).toEqual([2, 4]);
    const r = report(t, cards.length);
    expect(r.lines[0]).toMatch(/^emulator numbers/);
    expect(r.lines.slice(1, 3).every((l) => /^(ok  |OVER) search/.test(l))).toBe(true);
  });
});
