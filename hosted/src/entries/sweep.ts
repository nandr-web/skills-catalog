// The sweep function's entry (contract §1.1), run on a schedule: both passes over the table and the bucket its
// environment names. It logs and answers how many files it deleted, marked and unmarked, never which.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import type { Clock } from '@skills-catalog/core';
import { HostedSweep } from '../sweep.ts';
import { sweepSettings } from './settings.ts';

const systemClock: Clock = { now: () => new Date() };

export type SweepCounts = { deleted: number; marked: number; unmarked: number };

export function openSweep(p: {
  env: Record<string, string | undefined>;
  ddb: DynamoDBClient;
  s3: S3Client;
  clock?: Clock;
  log?: (line: string) => void;
}): () => Promise<SweepCounts> {
  const { place } = sweepSettings(p.env);
  const sweep = new HostedSweep({ ddb: p.ddb, s3: p.s3, place, clock: p.clock ?? systemClock });
  const log = p.log ?? ((line: string) => console.error(line));
  return async () => {
    const r = await sweep.run();
    const counts = { deleted: r.deleted.length, marked: r.marked.length, unmarked: r.unmarked.length };
    log(`sweep: deleted ${counts.deleted}, marked ${counts.marked}, unmarked ${counts.unmarked}`);
    return counts;
  };
}

let sweep: (() => Promise<SweepCounts>) | undefined;

export async function handler(): Promise<SweepCounts> {
  sweep ??= openSweep({ env: process.env, ddb: new DynamoDBClient({}), s3: new S3Client({}) });
  return sweep();
}
