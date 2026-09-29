// Which versions name a file, hosted (contract §1.1): after each publish the one indexer writes an item per file,
// file#<sha256> / <name>#<version>, never inside the commit's transaction (it stays at four actions). The answer trails a
// publish by seconds, like the search index; installing never waits on it (a fetch issues its links from the version it
// reads). Rebuildable from the versions at any time; writing the same version twice changes nothing.

import { BatchWriteItemCommand, QueryCommand, type BatchWriteItemCommandOutput, type DynamoDBClient, type WriteRequest } from '@aws-sdk/client-dynamodb';
import type { Storage, VersionPublished, VersionRecord } from '@skills-catalog/core';
import { versionSk, type Place } from './place.ts';

// DynamoDB's limit on one batch write.
const BATCH = 25;

export const fileNamePk = (sha256: string) => `file#${sha256}`;

export class HostedFileNames {
  private readonly p: { ddb: DynamoDBClient; place: Place };

  constructor(parts: { ddb: DynamoDBClient; place: Place }) {
    this.p = parts;
  }

  /** The indexer's step for one published version: each of its files is named by it. */
  async record(v: VersionRecord): Promise<void> {
    const sk = `${v.name}#${versionSk(v.version)}`;
    const puts: WriteRequest[] = [...new Set(v.files.map((f) => f.sha256))].map((sha) => ({ PutRequest: { Item: { pk: { S: fileNamePk(sha) }, sk: { S: sk } } } }));
    for (let i = 0; i < puts.length; i += BATCH) {
      let pending: WriteRequest[] | undefined = puts.slice(i, i + BATCH);
      for (let attempt = 1; pending?.length; attempt++) {
        if (attempt > 5) throw new Error('the file names kept coming back unprocessed');
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
