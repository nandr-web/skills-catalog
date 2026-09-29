// Which versions name a file, hosted (contract §1.1): after each publish the one indexer writes an item per file,
// file#<sha256> / <name>#<version>, never inside the commit's transaction (it stays at four actions). The answer trails a
// publish by seconds, like the search index; installing never waits on it (a fetch issues its links from the version it
// reads). Rebuildable from the versions at any time; writing the same version twice changes nothing.

import { BatchWriteItemCommand, QueryCommand, type BatchWriteItemCommandOutput, type DynamoDBClient, type WriteRequest } from '@aws-sdk/client-dynamodb';
import type { Storage, VersionPublished, VersionRecord } from '@skills-catalog/core';
import { versionSk, type Place } from './place.ts';

// DynamoDB's limit on one batch write.
const BATCH = 25;
// Items a busy table leaves unprocessed are written again after a wait that doubles from BACKOFF_MS up to BACKOFF_CAP_MS,
// plus jitter of up to one step, at most TRIES times.
const TRIES = 6;
const BACKOFF_MS = 50;
const BACKOFF_CAP_MS = 2000;

export const fileNamePk = (sha256: string) => `file#${sha256}`;

export type NamesParts = { ddb: DynamoDBClient; place: Place; sleep?: (ms: number) => Promise<void>; random?: () => number };

export class HostedFileNames {
  private readonly p: Required<NamesParts>;

  constructor(parts: NamesParts) {
    this.p = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random, ...parts };
  }

  /** The indexer's step for one published version: each of its files is named by it. */
  async record(v: VersionRecord): Promise<void> {
    const sk = `${v.name}#${versionSk(v.version)}`;
    const puts: WriteRequest[] = [...new Set(v.files.map((f) => f.sha256))].map((sha) => ({ PutRequest: { Item: { pk: { S: fileNamePk(sha) }, sk: { S: sk } } } }));
    for (let i = 0; i < puts.length; i += BATCH) {
      let pending: WriteRequest[] | undefined = puts.slice(i, i + BATCH);
      for (let attempt = 0; pending?.length; attempt++) {
        if (attempt >= TRIES) throw new Error('the file names kept coming back unprocessed (the table is busy)');
        if (attempt > 0) {
          const step = Math.min(BACKOFF_CAP_MS, BACKOFF_MS * 2 ** (attempt - 1));
          await this.p.sleep(step * (1 + this.p.random()));
        }
        const r: BatchWriteItemCommandOutput = await this.p.ddb.send(new BatchWriteItemCommand({ RequestItems: { [this.p.place.table]: pending } }));
        pending = r.UnprocessedItems?.[this.p.place.table];
      }
    }
  }

  /** Whether any version the indexer has recorded names this file. */
  async named(sha256: string): Promise<boolean> {
    const r = await this.p.ddb.send(
      new QueryCommand({ TableName: this.p.place.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: fileNamePk(sha256) } }, Limit: 1 }),
    );
    return (r.Items?.length ?? 0) > 0;
  }
}

/** The indexer's subscriber to version_published (beside the search index's): it names the event's version's files.
 *  Run again for the same event, it changes nothing (at-least-once delivery). */
export function namesIndexer(parts: { storage: Pick<Storage, 'version'>; names: HostedFileNames }): (e: VersionPublished) => Promise<void> {
  return async (e) => {
    const v = await parts.storage.version(e.name, e.version);
    // The event is written in the version's own transaction, so its version is always there.
    if (!v) throw new Error(`version_published for ${e.name} v${e.version}, which isn't stored`);
    await parts.names.record(v);
  };
}
