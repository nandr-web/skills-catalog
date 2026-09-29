// Which versions name a file, hosted (contract §1.1; the AWS build brief): the one indexer writes a sha256 → version item
// per file after each publish, never inside the commit's transaction, so the answer trails a publish by seconds. The
// storage's file state reads it: named once the indexer has run; before that, a file uploaded or claimed under a day ago
// is on its way (the files route's 503), and anything else is unknown (404).

import { createHash } from 'node:crypto';
import { DynamoDBClient, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { NewVersion, VersionPublished } from '@skills-catalog/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStores, HostedBlobLinks, HostedEvents, HostedFileNames, HostedStorage, namesIndexer, type Place } from '../src/index.ts';
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
  const place: Place = { table: `names-${++n}`, bucket: `names-${n}` };
  const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
  const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  await createStores(ddb, s3, place);
  let t = Date.now();
  const clock = { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
  const names = new HostedFileNames({ ddb, place });
  const storage = new HostedStorage({ ddb, s3, place, clock });
  const links = new HostedBlobLinks({ s3, place, clock });
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  async function upload(text: string): Promise<string> {
    const [a] = await links.uploadLinks([{ sha256: sha(text), size: Buffer.byteLength(text) }]);
    if (a!.kind !== 'upload') throw new Error(`expected a link, got ${a!.kind}`);
    const r = await fetch(a!.url, { method: 'PUT', body: text, headers: a!.headers });
    if (!r.ok) throw new Error(`upload answered ${r.status}`);
    return sha(text);
  }
  let versions = 0;
  async function publish(name: string, shas: string[]) {
    const v: NewVersion = { name, fingerprint: `sha256:${sha(`v${++versions}`)}`, publisher: 'ana', message: '', published_at: clock.now().toISOString(), files: shas.map((s, i) => ({ path: `f${i}.md`, mode: '0644', sha256: s, size: 1 }) as never), description: 'Named.', tags: [], frontmatter: {} };
    const event = (version: number): VersionPublished => ({ type: 'version_published', name, version, fingerprint: v.fingerprint, publisher: 'ana', at: v.published_at });
    const r = await storage.commit(v, shas.map((s) => ({ sha256: s })), {}, event);
    if (r.kind !== 'created') throw new Error(`expected created, got ${r.kind}`);
    return r.record;
  }
  return { ddb, place, clock, names, storage, sha, upload, publish };
}

describe('which versions name a file', () => {
  it('right after a publish the files are on their way; once the indexer records the version they are named', async () => {
    const w = await world();
    const a = await w.upload('a\n');
    const b = await w.upload('b\n');
    const record = await w.publish('named', [a, b]);
    expect(await w.storage.fileState(a)).toBe('on_its_way');
    await w.names.record(record);
    expect(await w.storage.fileState(a)).toBe('named');
    expect(await w.storage.fileState(b)).toBe('named');
  });

  it('a named file stays named however old it gets, and recording a version twice changes nothing', async () => {
    const w = await world();
    const a = await w.upload('kept\n');
    const record = await w.publish('kept', [a]);
    await w.names.record(record);
    await w.names.record(record);
    w.clock.advance(30 * DAY);
    expect(await w.storage.fileState(a)).toBe('named');
  });

  it('a file never uploaded, or uploaded over a day ago and never published, is unknown', async () => {
    const w = await world();
    expect(await w.storage.fileState(w.sha('never\n'))).toBe('unknown');
    const old = await w.upload('old\n');
    w.clock.advance(DAY + HOUR);
    expect(await w.storage.fileState(old)).toBe('unknown');
  });

  it('the names are never written by the commit: its transaction keeps its four actions', async () => {
    const w = await world();
    const counts: number[] = [];
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = ((cmd: unknown, ...rest: unknown[]) => {
      if (cmd instanceof TransactWriteItemsCommand) counts.push(cmd.input.TransactItems!.length);
      return (send as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as typeof w.ddb.send;
    const a = await w.upload('four\n');
    await w.publish('four', [a]);
    expect(counts).toEqual([4]);
    expect(await w.storage.fileState(a)).toBe('on_its_way');
  });
});

describe('the indexer names the files of each published version', () => {
  it('delivering the version_published event records its files, from the version the event names', async () => {
    const w = await world();
    const events = new HostedEvents({ ddb: w.ddb, place: w.place });
    events.subscribe(namesIndexer({ storage: w.storage, names: w.names }));
    const a = await w.upload('one\n');
    const b = await w.upload('two\n');
    await w.publish('indexed', [a]);
    await w.publish('indexed', [a, b]);
    expect(await w.storage.fileState(b)).toBe('on_its_way');
    expect(await events.deliver()).toBe(2);
    expect(await w.storage.fileState(a)).toBe('named');
    expect(await w.storage.fileState(b)).toBe('named');
  });

  it('an event for a version that is not there is a bug, not a silent skip', async () => {
    const w = await world();
    const index = namesIndexer({ storage: w.storage, names: w.names });
    await expect(index({ type: 'version_published', name: 'ghost', version: 1, fingerprint: 'sha256:x', publisher: 'ana', at: w.clock.now().toISOString() })).rejects.toThrow(/ghost/);
  });
});
