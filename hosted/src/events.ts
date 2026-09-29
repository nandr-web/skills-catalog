// Events, hosted adapter: the version_published event is an item the commit's transaction writes (contract §7), so an
// event exists exactly when its version does. deliver() hands pending events to the subscribers in order and marks each
// delivered; one that fails stays pending for the next delivery (at least once). In AWS the table's stream carries them
// to the indexer's queue as well; this is the same order read in process, and reads the whole events partition each
// time, so it's for in-process use only (the tests, a local run), never the deployed indexer.

import { QueryCommand, UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Events, VersionPublished } from '@skills-catalog/core';
import type { Place } from './place.ts';

/** Events as deployed: the table's stream carries each event item to the indexer's queue, so the API function delivers
 *  nothing itself (its subscribers never run there; the indexer function runs the same steps on each queued event). */
export const deliveredByTheStream: Events = { subscribe: () => {}, deliver: async () => 0 };

export class HostedEvents implements Events {
  private readonly p: { ddb: DynamoDBClient; place: Place };
  private readonly handlers: ((e: VersionPublished) => Promise<void>)[] = [];

  constructor(parts: { ddb: DynamoDBClient; place: Place }) {
    this.p = parts;
  }

  subscribe(handler: (e: VersionPublished) => Promise<void>): void {
    this.handlers.push(handler);
  }

  async deliver(): Promise<number> {
    let delivered = 0;
    let start: Record<string, import('@aws-sdk/client-dynamodb').AttributeValue> | undefined;
    do {
      const r = await this.p.ddb.send(
        new QueryCommand({
          TableName: this.p.place.table,
          KeyConditionExpression: 'pk = :pk',
          FilterExpression: 'delivered = :no',
          ExpressionAttributeValues: { ':pk': { S: 'events' }, ':no': { BOOL: false } },
          ExclusiveStartKey: start,
          ConsistentRead: true,
        }),
      );
      for (const item of r.Items ?? []) {
        const e = JSON.parse(item['event']!.S!) as VersionPublished;
        for (const h of this.handlers) await h(e);
        // Marked once: a delivery running beside this one may have handed it on too (at least once), and counts it.
        try {
          await this.p.ddb.send(
            new UpdateItemCommand({
              TableName: this.p.place.table,
              Key: { pk: item['pk']!, sk: item['sk']! },
              UpdateExpression: 'SET delivered = :yes',
              ConditionExpression: 'delivered = :no',
              ExpressionAttributeValues: { ':yes': { BOOL: true }, ':no': { BOOL: false } },
            }),
          );
        } catch (err) {
          if ((err as { name?: string }).name === 'ConditionalCheckFailedException') continue;
          throw err;
        }
        delivered++;
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return delivered;
  }
}
