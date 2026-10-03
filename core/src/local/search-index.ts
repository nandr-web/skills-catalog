// SearchIndex, local adapter: SQLite FTS5 over the name's words and the description, any word, ranked by bm25
// (contract §2). The body is not searched. Rebuildable from the versions at any time.

import type { SearchCard, SearchFilters, SearchHit, SearchIndex } from '../ports.ts';
import { LocalDb } from './db.ts';

interface CardRow {
  name: string;
  description: string;
  latest_version: number;
  tags: string;
  publisher: string;
  updated_at: string;
}

function toCard(r: CardRow): SearchCard {
  return { ...r, tags: JSON.parse(r.tags) };
}

// Words reach FTS5 as quoted strings, so nothing in a query is read as FTS5 syntax.
function quoted(word: string): string {
  return `"${word.replace(/"/g, '""')}"`;
}

function matchExpr(words: string[]): string {
  return `{words description}: (${words.map(quoted).join(' OR ')})`;
}

export class SqliteSearchIndex implements SearchIndex {
  private readonly local: LocalDb;

  constructor(local: LocalDb) {
    this.local = local;
  }

  private get db() {
    return this.local.db;
  }

  async upsert(card: SearchCard): Promise<void> {
    this.local.immediate(() => this.write(card));
  }

  // `fresh`: the tables were just emptied, so there is no old row to delete. Deleting by name scans the whole full-text
  // table (name isn't indexed there), which made a rebuild grow with the square of the catalog (5-7 s at 10,000 cards).
  private write(card: SearchCard, fresh = false): void {
    if (!fresh) this.db.prepare('DELETE FROM search_fts WHERE name = ?').run(card.name);
    this.db.prepare('INSERT INTO search_fts (name, words, description) VALUES (?, ?, ?)').run(card.name, card.name.replace(/-/g, ' '), card.description);
    this.db
      .prepare('INSERT OR REPLACE INTO search_cards (name, description, latest_version, tags, publisher, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(card.name, card.description, card.latest_version, JSON.stringify(card.tags), card.publisher, card.updated_at);
  }

  async rebuild(cards: readonly SearchCard[]): Promise<void> {
    this.local.immediate(() => {
      this.db.exec('DELETE FROM search_fts; DELETE FROM search_cards;');
      // One row per name, the last given winning, as upserts in order would leave it.
      const byName = new Map(cards.map((c) => [c.name, c]));
      for (const c of byName.values()) this.write(c, true);
    });
  }

  async query(words: string[], filters: SearchFilters): Promise<SearchHit[]> {
    let hits: SearchHit[];
    if (words.length === 0) {
      const rows = this.db.prepare('SELECT * FROM search_cards ORDER BY name').all() as unknown as CardRow[];
      hits = rows.map((r) => ({ card: toCard(r), matched_words: [] }));
    } else {
      const rows = this.db
        .prepare('SELECT c.* FROM search_fts f JOIN search_cards c ON c.name = f.name WHERE search_fts MATCH ? ORDER BY bm25(search_fts), c.name')
        .all(matchExpr(words)) as unknown as CardRow[];
      const matched = new Map<string, string[]>();
      for (const w of words) {
        const names = this.db.prepare('SELECT name FROM search_fts WHERE search_fts MATCH ?').all(matchExpr([w])) as { name: string }[];
        for (const { name } of names) {
          const list = matched.get(name) ?? [];
          if (!list.includes(w)) list.push(w);
          matched.set(name, list);
        }
      }
      hits = rows.map((r) => ({ card: toCard(r), matched_words: matched.get(r.name) ?? [] }));
    }
    const { tags, publisher, updated_since } = filters;
    return hits.filter(
      ({ card }) =>
        (!tags || tags.every((t) => card.tags.includes(t))) &&
        (!publisher || card.publisher === publisher) &&
        (!updated_since || card.updated_at >= updated_since),
    );
  }
}

/** The same index on an in-memory database: another adapter keeps its cards elsewhere and ranks them here, so its
 *  results (the words matched, the stemming, the ranking and its ties) are the local catalog's by construction. */
export function memorySearchIndex(): SearchIndex & { close(): void } {
  const db = new LocalDb(':memory:');
  return Object.assign(new SqliteSearchIndex(db), { close: () => db.close() });
}
