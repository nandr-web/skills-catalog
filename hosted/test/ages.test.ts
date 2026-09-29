// The hosted file rules (contract §1.1), on the stand-in with a clock that starts at the real now (S3 stamps uploads with
// the real time) and that each test moves on: a commit takes a file only under a day old (from its upload or its last
// claim), with bytes that hash to its name and no `deleting` mark; the sweep marks an unreferenced file over 7 days old,
// and deletes it at least an hour later only if it's still unreferenced, still marked and still over 7 days old.

import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { NewVersion, VersionPublished } from '@skills-catalog/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blobKey, createStores, HostedBlobLinks, HostedStorage, HostedSweep, inspect, type Place } from '../src/index.ts';
import { changeTags } from '../src/blobs.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

let n = 0;
async function world() {
  const place: Place = { table: `ages-${++n}`, bucket: `ages-${n}` };
  const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
  const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  await createStores(ddb, s3, place);
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
  const storage = new HostedStorage({ ddb, s3, place, clock });
  const links = new HostedBlobLinks({ s3, place, clock });
  const sweep = new HostedSweep({ ddb, s3, place, clock });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  async function upload(text: string): Promise<string> {
    const [a] = await links.uploadLinks([{ sha256: sha(text), size: Buffer.byteLength(text) }]);
    if (a!.kind !== 'upload') throw new Error(`expected a link, got ${a!.kind}`);
    const r = await fetch(a!.url, { method: 'PUT', body: text, headers: a!.headers });
    if (!r.ok) throw new Error(`upload answered ${r.status}`);
    return sha(text);
  }
  let versions = 0;
  async function commit(shas: string[]) {
    const v: NewVersion = { name: 'aged', fingerprint: `sha256:${sha(`v${++versions}`)}`, publisher: 'ana', message: '', published_at: clock.now().toISOString(), files: shas.map((s, i) => ({ path: `f${i}.md`, mode: '0644', sha256: s, size: 1 }) as never), description: 'Aged.', tags: [], frontmatter: {} };
    const event = (version: number): VersionPublished => ({ type: 'version_published', name: 'aged', version, fingerprint: v.fingerprint, publisher: 'ana', at: v.published_at });
    return storage.commit(v, shas.map((s) => ({ sha256: s })), {}, event);
  }
  const stored = async (s: string) => (await inspect(s3, place, s)).kind === 'stored';
  const tags = async (s: string) => {
    const b = await inspect(s3, place, s);
    return b.kind === 'stored' ? b.tags : undefined;
  };
  return { place, ddb, s3, clock, storage, links, sweep, sha, upload, commit, stored, tags };
}

describe('a commit takes a file only under a day old', () => {
  it('at 23 hours it is taken; at 25 hours it is not_uploaded', async () => {
    const w = await world();
    const young = await w.upload('young\n');
    const old = await w.upload('old\n');
    w.clock.advance(23 * HOUR);
    expect(await w.commit([young])).toMatchObject({ kind: 'created' });
    w.clock.advance(2 * HOUR);
    expect(await w.commit([old])).toEqual({ kind: 'not_uploaded', missing: [old] });
  });

  it('a file marked for removal is not_uploaded however young, and the commit changes nothing', async () => {
    const w = await world();
    const s = await w.upload('fresh but marked\n');
    await changeTags(w.s3, w.place, s, (tags) => ({ ...tags, deleting: w.clock.now().toISOString() }));
    expect(await w.commit([s])).toEqual({ kind: 'not_uploaded', missing: [s] });
    expect(await w.storage.version('aged', 1)).toBeUndefined();
  });

  it('a claim refreshes a stale file: asked for again at 25 hours, it is answered as stored and a commit takes it', async () => {
    const w = await world();
    const s = await w.upload('stale\n');
    w.clock.advance(25 * HOUR);
    expect(await w.links.uploadLinks([{ sha256: s, size: 6 }])).toEqual([{ kind: 'stored', sha256: s }]);
    expect(await w.commit([s])).toMatchObject({ kind: 'created' });
  });

  it('bytes that do not hash to their name are never taken, get no link, and the sweep removes them at once', async () => {
    const w = await world();
    const s = w.sha('what the name says\n');
    // Put straight into the bucket (the stand-in doesn't check a declared checksum; real S3 refuses at upload).
    await w.s3.send(new PutObjectCommand({ Bucket: w.place.bucket, Key: blobKey(s), Body: 'other bytes\n', IfNoneMatch: '*' }));
    expect(await w.commit([s])).toEqual({ kind: 'not_uploaded', missing: [s] });
    expect((await w.links.uploadLinks([{ sha256: s, size: 19 }]))[0]).toMatchObject({ kind: 'removing', sha256: s });
    await w.sweep.run();
    expect(await w.stored(s)).toBe(false);
  });
});

describe('the sweep marks, then deletes', () => {
  it('an unreferenced file at 6 days 23 hours is left; at 7 days 1 hour it is marked, not deleted; an hour after the mark it is deleted', async () => {
    const w = await world();
    const s = await w.upload('unreferenced\n');
    w.clock.advance(6 * DAY + 23 * HOUR);
    await w.sweep.run();
    expect(await w.tags(s)).not.toHaveProperty('deleting');
    w.clock.advance(2 * HOUR);
    await w.sweep.run();
    expect(await w.tags(s)).toHaveProperty('deleting');
    w.clock.advance(HOUR - 1000);
    await w.sweep.run();
    expect(await w.stored(s)).toBe(true);
    w.clock.advance(1000);
    await w.sweep.run();
    expect(await w.stored(s)).toBe(false);
  });

  it('a referenced file is never marked, however old', async () => {
    const w = await world();
    const s = await w.upload('kept\n');
    expect(await w.commit([s])).toMatchObject({ kind: 'created' });
    w.clock.advance(30 * DAY);
    await w.sweep.run();
    expect(await w.tags(s)).not.toHaveProperty('deleting');
    w.clock.advance(2 * HOUR);
    await w.sweep.run();
    expect(await w.stored(s)).toBe(true);
  });

  it('a claim on a marked file gets the retry answer, no link and no claim', async () => {
    const w = await world();
    const s = await w.upload('marked\n');
    w.clock.advance(7 * DAY + HOUR);
    await w.sweep.run();
    const [a] = await w.links.uploadLinks([{ sha256: s, size: 7 }]);
    expect(a).toMatchObject({ kind: 'removing', sha256: s });
    expect(Date.parse((a as { retry_after: string }).retry_after)).toBeGreaterThan(w.clock.now().getTime());
    expect(await w.tags(s)).not.toHaveProperty('claimed');
  });

  it('a claim and a commit just before the mark: the second pass finds the file referenced, keeps it and takes the mark off', async () => {
    const w = await world();
    const s = await w.upload('raced\n');
    w.clock.advance(7 * DAY + HOUR);
    // Between the sweep's look and its mark, a publish claims the file and commits a version that references it.
    await w.sweep.run({
      beforeMark: async () => {
        expect(await w.links.uploadLinks([{ sha256: s, size: 6 }])).toEqual([{ kind: 'stored', sha256: s }]);
        expect(await w.commit([s])).toMatchObject({ kind: 'created' });
      },
    });
    expect(await w.tags(s)).toMatchObject({ deleting: expect.any(String), claimed: expect.any(String) });
    w.clock.advance(HOUR);
    await w.sweep.run();
    expect(await w.stored(s)).toBe(true);
    expect(await w.tags(s)).not.toHaveProperty('deleting');
  });

  it('a file referenced after its mark is kept even when the second pass comes over 7 days later (the claim has aged out too)', async () => {
    const w = await world();
    const s = await w.upload('late\n');
    w.clock.advance(7 * DAY + HOUR);
    await w.sweep.run({ beforeMark: async () => {
      await w.links.uploadLinks([{ sha256: s, size: 5 }]);
      expect(await w.commit([s])).toMatchObject({ kind: 'created' });
    } });
    // The sweep doesn't run again for over a week: the file is old from its claim as well, and still marked.
    w.clock.advance(7 * DAY + 2 * HOUR);
    await w.sweep.run();
    expect(await w.stored(s)).toBe(true);
    expect(await w.tags(s)).not.toHaveProperty('deleting');
  });

  it('a version committed after the sweep first looks and before the second pass reads the versions again keeps the file, and the mark comes off', async () => {
    const w = await world();
    const s = await w.upload('late commit\n');
    w.clock.advance(7 * DAY + HOUR);
    await w.sweep.run();
    expect(await w.tags(s)).toHaveProperty('deleting');
    w.clock.advance(HOUR);
    // A publish that checked the file just before its mark lands now: its version references the file.
    await w.sweep.run({
      beforeRecheck: async () => {
        await changeTags(w.s3, w.place, s, ({ deleting: _, ...rest }) => ({ ...rest, claimed: w.clock.now().toISOString() }));
        expect(await w.commit([s])).toMatchObject({ kind: 'created' });
        await changeTags(w.s3, w.place, s, (tags) => ({ ...tags, deleting: new Date(w.clock.now().getTime() - 2 * HOUR).toISOString(), claimed: new Date(w.clock.now().getTime() - 8 * DAY).toISOString() }));
      },
    });
    expect(await w.stored(s)).toBe(true);
    expect(await w.tags(s)).not.toHaveProperty('deleting');
  });

  it('a claim just before the mark with no commit: the file is young again, so the second pass keeps it and takes the mark off', async () => {
    const w = await world();
    const s = await w.upload('claimed\n');
    w.clock.advance(7 * DAY + HOUR);
    await w.sweep.run({ beforeMark: async () => void (await w.links.uploadLinks([{ sha256: s, size: 8 }])) });
    w.clock.advance(HOUR);
    await w.sweep.run();
    expect(await w.stored(s)).toBe(true);
    expect(await w.tags(s)).not.toHaveProperty('deleting');
  });
});
