// The indexer's file names under throttling: DynamoDB answers a batch write with items it didn't process when the table
// is busy, so the names are written again after a wait that doubles each time (with jitter, capped), never back to back.

import { BatchWriteItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { HostedFileNames } from '../src/names.ts';

const record = (n: number) => ({ name: 'busy', version: 1, files: Array.from({ length: n }, (_, i) => ({ sha256: i.toString(16).padStart(64, '0') })) }) as never;

/** A table that leaves the first `busy` answers' items unprocessed (all but the first of each batch). */
function busyTable(busy: number) {
  const batches: number[] = [];
  let left = busy;
  const ddb = {
    send: async (cmd: unknown) => {
      if (!(cmd instanceof BatchWriteItemCommand)) throw new Error('only batch writes here');
      const items = cmd.input.RequestItems!['t']!;
      batches.push(items.length);
      if (left-- > 0) return { UnprocessedItems: { t: items.slice(1) } };
      return { UnprocessedItems: {} };
    },
  } as unknown as DynamoDBClient;
  return { ddb, batches };
}

describe('file names under throttling', () => {
  it('unprocessed items are written again after a wait that doubles, plus jitter of up to one step', async () => {
    const { ddb, batches } = busyTable(2);
    const waits: number[] = [];
    const names = new HostedFileNames({ ddb, place: { table: 't', bucket: 'b' }, sleep: async (ms) => void waits.push(ms), random: () => 0.5 });
    await names.record(record(3));
    expect(batches).toEqual([3, 2, 1]);
    expect(waits).toEqual([50 * 1.5, 100 * 1.5]);
  });

  it('the wait is capped, and a table that stays busy fails after its tries rather than loop', async () => {
    const { ddb } = busyTable(100);
    const waits: number[] = [];
    const names = new HostedFileNames({ ddb, place: { table: 't', bucket: 'b' }, sleep: async (ms) => void waits.push(ms), random: () => 0.999 });
    await expect(names.record(record(30))).rejects.toThrow(/unprocessed/);
    expect(waits.length).toBeGreaterThan(3);
    expect(Math.max(...waits)).toBeLessThanOrEqual(2000 * 2);
  });
});
