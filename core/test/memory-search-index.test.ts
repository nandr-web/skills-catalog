// The local search index on an in-memory database (for an adapter that keeps its cards elsewhere and ranks them the
// local catalog's way): it ranks what it was given, and closing it lets its database go.

import { describe, expect, it } from 'vitest';
import { memorySearchIndex } from '../src/index.ts';
import { expectLinear } from './linear.ts';

const card = (name: string, description: string) => ({ name, description, latest_version: 1, tags: [], publisher: 'ana', updated_at: '2026-09-29T00:00:00.000Z' });

describe('the in-memory search index', () => {
  it('ranks the cards it was rebuilt from, as the local index does', async () => {
    const index = memorySearchIndex();
    await index.rebuild([card('release-notes-draft', 'Drafts release notes.'), card('pr-review', 'Reviews a pull request.')]);
    expect((await index.query(['release'], {})).map((h) => h.card.name)).toEqual(['release-notes-draft']);
    index.close();
  });

  it('once closed, its database is gone: a query fails rather than answer from nothing', async () => {
    const index = memorySearchIndex();
    await index.rebuild([card('a-skill', 'Anything.')]);
    index.close();
    await expect(index.query(['anything'], {})).rejects.toThrow();
    index.close();
  });

  // A hosted query rebuilds this index whenever the search file changed (every publish, every cold start): at 10,000
  // cards a rebuild that deleted each card's old row first took 5-7 s (each delete scans the whole full-text table).
  it('rebuilds in time that grows in step with the number of cards, not its square (the review of 2026-10-02, P15.1)', () => {
    const cards = (scale: number) => Array.from({ length: Math.round(4000 * scale) }, (_, i) => card(`skill-${i}`, `Drafts thing number ${i} for the team. Use when needed.`));
    expectLinear('rebuild', cards, (cs) => {
      const index = memorySearchIndex();
      void index.rebuild(cs);
      index.close();
    });
  }, 60_000);

  it('a rebuild replaces every card, and an upsert after it replaces that one card', async () => {
    const index = memorySearchIndex();
    await index.rebuild([card('a-skill', 'Drafts release notes.'), card('b-skill', 'Reviews a pull request.')]);
    await index.rebuild([card('b-skill', 'Reviews a terraform plan.')]);
    expect((await index.query([], {})).map((h) => h.card.name)).toEqual(['b-skill']);
    expect(await index.query(['pull'], {})).toEqual([]);
    await index.upsert(card('b-skill', 'Reviews a pull request.'));
    expect((await index.query(['pull'], {})).map((h) => h.card.name)).toEqual(['b-skill']);
    expect(await index.query(['terraform'], {})).toEqual([]);
    index.close();
  });
});
