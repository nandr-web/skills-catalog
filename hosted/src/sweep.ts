// The sweep, hosted only (contract §1.1), run on a schedule under its own role (the only one that may delete a file):
// files no version references go, in two passes so a publish that claims a file meanwhile never loses it.
//   Pass 2 (first in each run): a file marked `deleting` at least MARK_WAIT_MS ago is looked at again, with the version
//     records read afresh: deleted only if it's still unreferenced, still marked and still over SWEEP_AGE_MS old;
//     otherwise its mark is taken off.
//   Pass 1: each unreferenced file over SWEEP_AGE_MS old is marked with the time. A marked file gets no upload link, no
//     claim, and no commit takes it.
// A file whose bytes don't hash to its name can never be committed, so it's deleted at once, whatever its age.

import { DeleteObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import { ScanCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Clock, VersionRecord } from '@skills-catalog/core';
import { ageOf, changeTags, inspect, MARK_WAIT_MS, SWEEP_AGE_MS } from './blobs.ts';
import { BLOB_PREFIX, blobKey, type Place } from './place.ts';

export class HostedSweep {
  private readonly p: { ddb: DynamoDBClient; s3: S3Client; place: Place; clock: Clock };

  constructor(parts: { ddb: DynamoDBClient; s3: S3Client; place: Place; clock: Clock }) {
    this.p = parts;
  }

  /** Every file a version references, read from the version records. */
  private async referenced(): Promise<Set<string>> {
    const out = new Set<string>();
    let start: Record<string, AttributeValue> | undefined;
    do {
      const r = await this.p.ddb.send(
        new ScanCommand({ TableName: this.p.place.table, FilterExpression: 'begins_with(pk, :v)', ExpressionAttributeValues: { ':v': { S: 'v#' } }, ExclusiveStartKey: start, ConsistentRead: true }),
      );
      for (const item of r.Items ?? []) for (const f of (JSON.parse(item['data']!.S!) as VersionRecord).files) out.add(f.sha256);
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  private async stored(): Promise<string[]> {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await this.p.s3.send(new ListObjectsV2Command({ Bucket: this.p.place.bucket, Prefix: BLOB_PREFIX, ContinuationToken: token }));
      for (const o of r.Contents ?? []) out.push(o.Key!.slice(BLOB_PREFIX.length));
      token = r.NextContinuationToken;
    } while (token);
    return out;
  }

  private remove(sha256: string) {
    return this.p.s3.send(new DeleteObjectCommand({ Bucket: this.p.place.bucket, Key: blobKey(sha256) }));
  }

  /** One scheduled run. `beforeMark` is a test seam: it runs between pass 1's look and its marks. */
  async run({ beforeMark }: { beforeMark?: () => Promise<void> } = {}): Promise<{ deleted: string[]; marked: string[]; unmarked: string[] }> {
    const done = { deleted: [] as string[], marked: [] as string[], unmarked: [] as string[] };
    const due: string[] = [];
    const candidates: string[] = [];
    const referenced = await this.referenced();
    for (const sha of await this.stored()) {
      const b = await inspect(this.p.s3, this.p.place, sha);
      if (b.kind !== 'stored') continue;
      const now = this.p.clock.now();
      if (!b.matches) {
        await this.remove(sha);
        done.deleted.push(sha);
      } else if (b.tags['deleting'] !== undefined) {
        const at = Date.parse(b.tags['deleting']);
        if (!Number.isFinite(at) || now.getTime() - at >= MARK_WAIT_MS) due.push(sha);
      } else if (!referenced.has(sha) && ageOf(b, now) > SWEEP_AGE_MS) candidates.push(sha);
    }

    // Pass 2: look again at each file whose mark has waited, with the version records read afresh.
    if (due.length) {
      const fresh = await this.referenced();
      for (const sha of due) {
        const b = await inspect(this.p.s3, this.p.place, sha);
        if (b.kind !== 'stored') continue;
        const now = this.p.clock.now();
        if (!fresh.has(sha) && b.tags['deleting'] !== undefined && ageOf(b, now) > SWEEP_AGE_MS) {
          await this.remove(sha);
          done.deleted.push(sha);
        } else {
          await changeTags(this.p.s3, this.p.place, sha, ({ deleting: _, ...rest }) => rest);
          done.unmarked.push(sha);
        }
      }
    }

    // Pass 1: mark what's unreferenced and old; the next run past the wait decides.
    await beforeMark?.();
    for (const sha of candidates) {
      const at = this.p.clock.now().toISOString();
      await changeTags(this.p.s3, this.p.place, sha, (tags) => ({ ...tags, deleting: at }));
      done.marked.push(sha);
    }
    return done;
  }
}
