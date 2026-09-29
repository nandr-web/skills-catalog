// The local search index on an in-memory database (for an adapter that keeps its cards elsewhere and ranks them the
// local catalog's way): it ranks what it was given, and closing it lets its database go.

import { describe, expect, it } from 'vitest';
import { memorySearchIndex } from '../src/index.ts';

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
});
