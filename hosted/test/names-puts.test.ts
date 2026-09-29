// The indexer's file names, written one PutItem per distinct file (the AWS build brief): no role may batch-write, since a
// batch write can delete. A few puts run at once; the client's own retries absorb throttling (six attempts, its jittered
// backoff), and a put that still fails fails the record, so the event is delivered again.

import { BatchWriteItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { HostedFileNames, NAMES_PUTS_AT_ONCE, namesClient } from '../src/names.ts';

const sha = (i: number) => i.toString(16).padStart(64, '0');
const record = (shas: string[]) => ({ name: 'named', version: 3, files: shas.map((s) => ({ sha256: s })) }) as never;

/** A table that answers each command a tick later, remembering every command and the most in flight at once. */
function table(opts: { failOn?: string } = {}) {
  const sent: unknown[] = [];
  let inFlight = 0;
  let most = 0;
  const ddb = {
    send: async (cmd: unknown) => {
      sent.push(cmd);
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      if (cmd instanceof PutItemCommand && opts.failOn && cmd.input.Item!['pk']!.S === `file#${opts.failOn}`) throw new Error('ProvisionedThroughputExceededException');
      return {};
    },
  } as unknown as DynamoDBClient;
  return { ddb, sent, most: () => most };
}

describe('file names, one put per file', () => {
  it('each distinct file is one PutItem naming the version; a file listed twice is put once; nothing is batch-written', async () => {
    const t = table();
    const names = new HostedFileNames({ ddb: t.ddb, place: { table: 't', bucket: 'b' } });
    await names.record(record([sha(1), sha(2), sha(1)]));
    expect(t.sent.some((c) => c instanceof BatchWriteItemCommand)).toBe(false);
    expect(t.sent.every((c) => c instanceof PutItemCommand)).toBe(true);
    const items = (t.sent as PutItemCommand[]).map((c) => ({ table: c.input.TableName, pk: c.input.Item!['pk']!.S, sk: c.input.Item!['sk']!.S }));
    expect(items.sort((a, b) => a.pk!.localeCompare(b.pk!))).toEqual([
      { table: 't', pk: `file#${sha(1)}`, sk: 'named#0000000003' },
      { table: 't', pk: `file#${sha(2)}`, sk: 'named#0000000003' },
    ]);
  });

  it('at most 8 puts are in flight at once, and every file is still put', async () => {
    const t = table();
    const names = new HostedFileNames({ ddb: t.ddb, place: { table: 't', bucket: 'b' } });
    await names.record(record(Array.from({ length: 30 }, (_, i) => sha(i))));
    expect(NAMES_PUTS_AT_ONCE).toBe(8);
    expect(t.sent.length).toBe(30);
    expect(t.most()).toBe(8);
  });

  it('a put that fails (after the client has retried it) fails the record, so the event comes again', async () => {
    const t = table({ failOn: sha(5) });
    const names = new HostedFileNames({ ddb: t.ddb, place: { table: 't', bucket: 'b' } });
    await expect(names.record(record(Array.from({ length: 12 }, (_, i) => sha(i))))).rejects.toThrow(/ProvisionedThroughput/);
  });

  it("the indexer's DynamoDB client tries each call six times (its own jittered backoff), whatever else it's given", async () => {
    const c = namesClient({ region: 'us-east-1', maxAttempts: 2 });
    try {
      expect(await c.config.maxAttempts()).toBe(6);
      expect(await c.config.region()).toBe('us-east-1');
    } finally {
      c.destroy();
    }
  });
});
