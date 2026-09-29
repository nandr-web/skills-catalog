// Events, local adapter: the outbox table is written in the same transaction as the version, then delivered to the
// in-process subscribers (at least once, in order). Anything left pending by a crash is delivered by the next
// process that opens the catalog or searches it.

import type { Clock, Events, VersionPublished } from '../ports.ts';
import type { LocalDb } from './db.ts';

export class LocalOutbox implements Events {
  private readonly local: LocalDb;
  private readonly clock: Clock;
  private readonly handlers: ((e: VersionPublished) => void)[] = [];

  constructor(local: LocalDb, clock: Clock) {
    this.local = local;
    this.clock = clock;
  }

  subscribe(handler: (e: VersionPublished) => void): void {
    this.handlers.push(handler);
  }

  pending(): number {
    return (this.local.db.prepare('SELECT count(*) AS n FROM outbox WHERE delivered_at IS NULL').get() as { n: number }).n;
  }

  deliver(): number {
    const db = this.local.db;
    let delivered = 0;
    for (;;) {
      const rows = db.prepare('SELECT id, event FROM outbox WHERE delivered_at IS NULL ORDER BY id LIMIT 100').all() as { id: number; event: string }[];
      if (rows.length === 0) return delivered;
      for (const row of rows) {
        const event = JSON.parse(row.event) as VersionPublished;
        for (const h of this.handlers) h(event);
        this.local.immediate(() => db.prepare('UPDATE outbox SET delivered_at = ? WHERE id = ?').run(this.clock.now().toISOString(), row.id));
        delivered++;
      }
    }
  }
}
