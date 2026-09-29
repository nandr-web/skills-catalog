// The indexer function's entry (contract §7): the one reader of the events queue. For each queued version_published it
// re-indexes the skill from storage (the catalog's own step) and writes the version's file names, both safe to repeat;
// a message that fails is reported, with every one after it, so the queue gives them again in order.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { indexSkill, type Clock } from '@skills-catalog/core';
import { HostedFileNames, namesClient, namesIndexer, type NamesClient } from '../names.ts';
import { S3SearchIndex } from '../search.ts';
import { HostedStorage } from '../storage.ts';
import { onQueue, type QueueAnswer, type QueueEvent } from './queue.ts';
import { indexerSettings } from './settings.ts';

const systemClock: Clock = { now: () => new Date() };

export function openIndexer(p: {
  env: Record<string, string | undefined>;
  ddb: DynamoDBClient;
  s3: S3Client;
  names: NamesClient;
  log?: (line: string) => void;
}): (e: QueueEvent) => Promise<QueueAnswer> {
  const { place } = indexerSettings(p.env);
  const storage = new HostedStorage({ ddb: p.ddb, s3: p.s3, place, clock: systemClock });
  const index = new S3SearchIndex({ s3: p.s3, place });
  const name = namesIndexer({ storage, names: new HostedFileNames({ ddb: p.names, place }) });
  return onQueue(
    async (e) => {
      await indexSkill({ storage, index }, e.name);
      await name(e);
    },
    p.log ?? ((line: string) => console.error(line)),
  );
}

let indexer: ((e: QueueEvent) => Promise<QueueAnswer>) | undefined;

export async function handler(e: QueueEvent): Promise<QueueAnswer> {
  indexer ??= openIndexer({ env: process.env, ddb: new DynamoDBClient({}), s3: new S3Client({}), names: namesClient({}) });
  return indexer(e);
}
