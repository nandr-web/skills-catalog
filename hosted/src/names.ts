// Which versions name a file, hosted (contract §1.1): after each publish the one indexer writes an item per file,
// file#<sha256> / <name>#<version>, never inside the commit's transaction (it stays at four actions). The answer trails a
// publish by seconds, like the search index; installing never waits on it (a fetch issues its links from the version it
// reads). Rebuildable from the versions at any time; writing the same version twice changes nothing.

import { DynamoDBClient, PutItemCommand, QueryCommand, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { Storage, VersionPublished, VersionRecord } from '@skills-catalog/core';
import { versionSk, type Place } from './place.ts';

// One PutItem per file, never a batch write: a batch write can delete, and no role is given that right. This many run at
// once; throttling is the client's to absorb (NAMES_MAX_ATTEMPTS, its own jittered backoff).
export const NAMES_PUTS_AT_ONCE = 8;
const NAMES_MAX_ATTEMPTS = 6;

declare const SIX_ATTEMPTS: unique symbol;
/** A DynamoDB client only namesClient makes, so the names are never written through one that gives up sooner. */
export type NamesClient = DynamoDBClient & { readonly [SIX_ATTEMPTS]: true };

/** The indexer's DynamoDB client: the given settings, with each call tried NAMES_MAX_ATTEMPTS times. */
export function namesClient(config: DynamoDBClientConfig): NamesClient {
  return new DynamoDBClient({ ...config, maxAttempts: NAMES_MAX_ATTEMPTS }) as NamesClient;
}

export const fileNamePk = (sha256: string) => `file#${sha256}`;

/** Whether any version the indexer has recorded names this file (a read: any client). */
export async function isNamed(ddb: DynamoDBClient, place: Place, sha256: string): Promise<boolean> {
  const r = await ddb.send(new QueryCommand({ TableName: place.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: fileNamePk(sha256) } }, Limit: 1 }));
  return (r.Items?.length ?? 0) > 0;
}

export type NamesParts = { ddb: NamesClient; place: Place };

export class HostedFileNames {
  private readonly p: NamesParts;

  constructor(parts: NamesParts) {
    this.p = parts;
  }

  /** The indexer's step for one published version: each of its files is named by it. A put that fails fails the step. */
  async record(v: VersionRecord): Promise<void> {
    const sk = `${v.name}#${versionSk(v.version)}`;
    const shas = [...new Set(v.files.map((f) => f.sha256))];
    let next = 0;
    const worker = async () => {
      while (next < shas.length) {
        const sha = shas[next++]!;
        await this.p.ddb.send(new PutItemCommand({ TableName: this.p.place.table, Item: { pk: { S: fileNamePk(sha) }, sk: { S: sk } } }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(NAMES_PUTS_AT_ONCE, shas.length) }, worker));
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
