// The indexer's queue (contract §7): the table's stream carries each event item's insert through the pipe into a FIFO
// queue, one message a stream record, as JSON. Each message's version_published is handed on in order; the first that
// fails is reported with every one after it (unhandled, so the queue's order holds), and the queue gives them again. A
// message that isn't an event fails the same way, so after its retries it lands in the dead-letter queue, where the
// alarm sees it, rather than being dropped.

import type { VersionPublished } from '@skills-catalog/core';
import { EVENTS_PK } from '../place.ts';

/** The parts of an SQS event the indexer reads. */
export type QueueEvent = { Records: { messageId: string; body: string }[] };
export type QueueAnswer = { batchItemFailures: { itemIdentifier: string }[] };

type Image = Record<string, { S?: string } | undefined>;

/** The version_published in a queue message's stream record; thrown when it holds none. */
export function versionPublishedOf(body: string): VersionPublished {
  const record = JSON.parse(body) as { dynamodb?: { NewImage?: Image } };
  const image = record.dynamodb?.NewImage;
  if (image?.['pk']?.S !== EVENTS_PK || typeof image['event']?.S !== 'string') throw new Error('the message is not an event item');
  const e = JSON.parse(image['event'].S) as Partial<VersionPublished>;
  if (e.type !== 'version_published' || typeof e.name !== 'string' || !e.name || !Number.isInteger(e.version)) throw new Error('the event is not a version_published');
  return e as VersionPublished;
}

export function onQueue(step: (e: VersionPublished) => Promise<void>, log: (line: string) => void): (e: QueueEvent) => Promise<QueueAnswer> {
  return async (event) => {
    for (const [i, m] of event.Records.entries()) {
      try {
        await step(versionPublishedOf(m.body));
      } catch (e) {
        // The error's name only: a message can carry skill text.
        log(`indexer: message failed (${e instanceof Error ? e.name : typeof e})`);
        return { batchItemFailures: event.Records.slice(i).map((r) => ({ itemIdentifier: r.messageId })) };
      }
    }
    return { batchItemFailures: [] };
  };
}
