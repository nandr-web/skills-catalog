// SearchIndex, hosted adapter (contract §2, §7): the search cards in one file in S3, rewritten whole by its one
// writer with If-Match on the ETag it read (a lost race reads again). Queries rank in the function with the local
// catalog's own index on an in-memory database, rebuilt when the file's ETag changes, so the matched words, the
// stemming, the ranking and its ties are the local catalog's. Rebuildable from the versions at any time.

import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { memorySearchIndex, type SearchCard, type SearchFilters, type SearchHit, type SearchIndex } from '@skills-catalog/core';
import { SEARCH_KEY, type Place } from './place.ts';

const TRIES = 5;
type File = { etag?: string | undefined; cards: SearchCard[] };

export class S3SearchIndex implements SearchIndex {
  private readonly p: { s3: S3Client; place: Place };
  private ranked: { etag: string | undefined; index: SearchIndex } | undefined;

  constructor(parts: { s3: S3Client; place: Place }) {
    this.p = parts;
  }

  private async read(): Promise<File> {
    try {
      const r = await this.p.s3.send(new GetObjectCommand({ Bucket: this.p.place.bucket, Key: SEARCH_KEY }));
      return { etag: r.ETag, cards: (JSON.parse(await r.Body!.transformToString()) as { cards: SearchCard[] }).cards };
    } catch (e) {
      if ((e as { name?: string }).name === 'NoSuchKey' || (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return { cards: [] };
      throw e;
    }
  }

  private async write(cards: SearchCard[], etag: string | undefined | null): Promise<boolean> {
    const cond = etag === null ? {} : etag === undefined ? { IfNoneMatch: '*' } : { IfMatch: etag };
    try {
      await this.p.s3.send(new PutObjectCommand({ Bucket: this.p.place.bucket, Key: SEARCH_KEY, Body: JSON.stringify({ cards }), ContentType: 'application/json', ...cond }));
      return true;
    } catch (e) {
      if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 412) return false;
      throw e;
    }
  }

  async upsert(card: SearchCard): Promise<void> {
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const f = await this.read();
      const cards = [...f.cards.filter((c) => c.name !== card.name), card].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (await this.write(cards, f.etag)) return;
    }
    throw new Error('the search file kept changing while it was being written');
  }

  async rebuild(cards: readonly SearchCard[]): Promise<void> {
    await this.write([...cards].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)), null);
  }

  async query(words: string[], filters: SearchFilters): Promise<SearchHit[]> {
    const f = await this.read();
    if (!this.ranked || this.ranked.etag === undefined || this.ranked.etag !== f.etag) {
      const index = memorySearchIndex();
      await index.rebuild(f.cards);
      this.ranked = { etag: f.etag, index };
    }
    return this.ranked.index.query(words, filters);
  }
}
