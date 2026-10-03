// Storage, hosted adapter (contract §1.1, §5.1, §7): versions and the latest pointer in DynamoDB, files in S3 by sha256.
// Files arrive beforehand through upload links; the commit names them by sha256 alone, checks each is committable (bytes
// that hash to its name, under a day old, not being removed), then writes the version, the latest pointer (by
// condition), the fingerprint entry and the version_published event in one transaction. It never writes or deletes a
// file: a refused commit changes nothing, and files uploaded ahead of it stay unreferenced until the sweep.

import {
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type DynamoDBClient,
  type TransactWriteItem,
} from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import type { Clock, CommitResult, NewVersion, SkillRecord, Storage, VersionPublished, VersionRecord } from '@skills-catalog/core';
import type { Review } from '@skills-catalog/core/skill-tree';
import { committable, glance, inspect } from './blobs.ts';
import { fileState, type FileState } from './api/files.ts';
import { isNamed } from './names.ts';
import { blobKey, EVENTS_PK, reviewKey, versionSk, type Place } from './place.ts';

const S = (s: string): AttributeValue => ({ S: s });
const N = (n: number): AttributeValue => ({ N: String(n) });
// A commit that loses a race inside DynamoDB reads again and decides again, a few times.
const TRIES = 5;

export type HostedParts = { ddb: DynamoDBClient; s3: S3Client; place: Place; clock: Clock };

export class HostedStorage implements Storage {
  private readonly p: HostedParts;

  constructor(parts: HostedParts) {
    this.p = parts;
  }

  /** A file by fingerprint: named by a version the indexer has recorded, on its way (a fresh upload not named yet: the
   *  files route answers 503 with Retry-After), or unknown. */
  fileState(sha256: string): Promise<FileState> {
    return fileState(sha256, { named: (s) => isNamed(this.p.ddb, this.p.place, s), glance: (s) => glance(this.p.s3, this.p.place, s) }, this.p.clock.now());
  }

  private get table() {
    return this.p.place.table;
  }

  private async queryAll(pk: string, newestFirst = false): Promise<Record<string, AttributeValue>[]> {
    const out: Record<string, AttributeValue>[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const r = await this.p.ddb.send(
        new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': S(pk) }, ScanIndexForward: !newestFirst, ExclusiveStartKey: start, ConsistentRead: true }),
      );
      out.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async skill(name: string): Promise<SkillRecord | undefined> {
    const r = await this.p.ddb.send(new GetItemCommand({ TableName: this.table, Key: { pk: S('skills'), sk: S(name) }, ConsistentRead: true }));
    if (!r.Item) return undefined;
    return { name, owners: r.Item['owners']!.L!.map((o) => o.S!), latest: Number(r.Item['latest']!.N) };
  }

  async version(name: string, version: number): Promise<VersionRecord | undefined> {
    const r = await this.p.ddb.send(new GetItemCommand({ TableName: this.table, Key: { pk: S(`v#${name}`), sk: S(versionSk(version)) }, ConsistentRead: true }));
    return r.Item && (JSON.parse(r.Item['data']!.S!) as VersionRecord);
  }

  async byFingerprint(fingerprint: string): Promise<VersionRecord | undefined> {
    const r = await this.p.ddb.send(
      new QueryCommand({ TableName: this.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': S(`fp#${fingerprint}`) }, Limit: 1, ConsistentRead: true }),
    );
    const first = r.Items?.[0];
    if (!first) return undefined;
    const sk = first['sk']!.S!;
    const at = sk.lastIndexOf('#');
    return this.version(sk.slice(0, at), Number(sk.slice(at + 1)));
  }

  async versions(name: string, offset: number, limit: number): Promise<VersionRecord[]> {
    return (await this.queryAll(`v#${name}`, true)).slice(offset, offset + limit).map((i) => JSON.parse(i['data']!.S!) as VersionRecord);
  }

  async latestVersions(): Promise<VersionRecord[]> {
    const out: VersionRecord[] = [];
    for (const s of await this.queryAll('skills')) {
      const v = await this.version(s['sk']!.S!, Number(s['latest']!.N));
      if (v) out.push(v);
    }
    return out;
  }

  async names(): Promise<string[]> {
    return (await this.queryAll('skills')).map((i) => i['sk']!.S!).sort();
  }

  async count(): Promise<number> {
    return (await this.queryAll('skills')).length;
  }

  async blob(sha256: string): Promise<Uint8Array | undefined> {
    try {
      const r = await this.p.s3.send(new GetObjectCommand({ Bucket: this.p.place.bucket, Key: blobKey(sha256) }));
      return await r.Body!.transformToByteArray();
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return undefined;
      throw e;
    }
  }

  /** A version's reviews (contract §10), by reviewer id: one query on the skill's reviews, from that version's key on. */
  async reviews(name: string, version: number): Promise<Review[]> {
    const out: Review[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const r = await this.p.ddb.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :v)',
          ExpressionAttributeValues: { ':pk': S(`r#${name}`), ':v': S(`${versionSk(version)}#`) },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      for (const i of r.Items ?? []) {
        // An item that can't be read is skipped (as locally, a row that isn't JSON): as if that reviewer hadn't run.
        try {
          const review = JSON.parse(i['data']?.S ?? '') as Review;
          if (review && typeof review === 'object' && typeof review.reviewer === 'string') out.push(review);
        } catch {
          // unreadable
        }
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async putReview(name: string, version: number, review: Review): Promise<void> {
    await this.p.ddb.send(new PutItemCommand({ TableName: this.table, Item: reviewItem(name, version, review) }));
  }

  async commit(
    given: NewVersion,
    files: readonly { sha256: string; bytes?: Uint8Array | undefined }[],
    cond: { expectedLatest?: number | undefined },
    event: (version: number) => VersionPublished,
  ): Promise<CommitResult> {
    // The reviews are written beside the version, in the same transaction, never in its record.
    const { reviews = [], ...v } = given;
    // One way in: files go up through their links first, so the commit never carries bytes.
    if (files.some((f) => f.bytes !== undefined)) throw new Error('the hosted commit takes files by sha256 alone; upload them through their links first');
    // Each named file is checked once, after the owner, conflict and identical answers (the refusal order): its bytes
    // are read to hash them, so a retry of the transaction doesn't read them again.
    let checked = false;
    const filesUsable = async (): Promise<string[]> => {
      const now = this.p.clock.now();
      const missing: string[] = [];
      for (const sha of [...new Set(files.map((f) => f.sha256))]) if (!committable(await inspect(this.p.s3, this.p.place, sha), now)) missing.push(sha);
      checked = true;
      return missing;
    };

    for (let attempt = 1; ; attempt++) {
      const s = await this.skill(v.name);
      if (s && !s.owners.includes(v.publisher)) return { kind: 'not_owner', owners: s.owners };
      const latest = s?.latest ?? 0;
      if (cond.expectedLatest !== undefined && cond.expectedLatest !== latest) return { kind: 'conflict', latest };
      if (s) {
        const current = await this.version(v.name, latest);
        if (current && current.fingerprint === v.fingerprint) return { kind: 'identical', record: current };
      }
      if (!checked) {
        const missing = await filesUsable();
        if (missing.length) return { kind: 'not_uploaded', missing };
      }
      const version = latest + 1;
      const record: VersionRecord = { ...v, version };
      const e = event(version);
      const items: TransactWriteItem[] = [
        { Put: { TableName: this.table, Item: { pk: S(`v#${v.name}`), sk: S(versionSk(version)), data: S(JSON.stringify(record)), fingerprint: S(v.fingerprint) }, ConditionExpression: 'attribute_not_exists(pk)' } },
        s
          ? {
              Update: {
                TableName: this.table,
                Key: { pk: S('skills'), sk: S(v.name) },
                UpdateExpression: 'SET latest = :next',
                ConditionExpression: 'latest = :latest',
                ExpressionAttributeValues: { ':next': N(version), ':latest': N(latest) },
              },
            }
          : { Put: { TableName: this.table, Item: { pk: S('skills'), sk: S(v.name), owners: { L: [S(v.publisher)] }, latest: N(version) }, ConditionExpression: 'attribute_not_exists(pk)' } },
        { Put: { TableName: this.table, Item: { pk: S(`fp#${v.fingerprint}`), sk: S(`${v.name}#${versionSk(version)}`) } } },
        { Put: { TableName: this.table, Item: { pk: S(EVENTS_PK), sk: S(`${e.at}#${v.name}#${versionSk(version)}`), event: S(JSON.stringify(e)), delivered: { BOOL: false } } } },
        ...reviews.map((r): TransactWriteItem => ({ Put: { TableName: this.table, Item: reviewItem(v.name, version, r) } })),
      ];
      try {
        await this.p.ddb.send(new TransactWriteItemsCommand({ TransactItems: items }));
        return { kind: 'created', record };
      } catch (err) {
        // Another publish changed the skill between the read and the write: read again and decide again.
        if ((err as { name?: string }).name === 'TransactionCanceledException' && attempt < TRIES) continue;
        throw err;
      }
    }
  }
}

function reviewItem(name: string, version: number, review: Review): Record<string, AttributeValue> {
  const { pk, sk } = reviewKey(name, version, review.reviewer);
  return { pk: S(pk), sk: S(sk), data: S(JSON.stringify(review)) };
}
