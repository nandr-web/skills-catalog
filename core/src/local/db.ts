// The local catalog's SQLite file, shared by several processes on one folder (the MCP server, the CLI, serve):
// WAL mode, and every write in BEGIN IMMEDIATE (contract §7), so a writer waits its turn instead of failing.

import { DatabaseSync } from 'node:sqlite';

// Stemmed, so "review pull request" matches "reviewing pull requests" (contract §2); match and matched_words
// ask this same index, word by word, so they stem the same way.
export const TOKENIZE = 'porter unicode61';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  owners TEXT NOT NULL,
  latest INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  publisher TEXT NOT NULL,
  message TEXT NOT NULL,
  published_at TEXT NOT NULL,
  files TEXT NOT NULL,
  description TEXT NOT NULL,
  tags TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS versions_by_fingerprint ON versions (fingerprint);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (id) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS search_cards (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  latest_version INTEGER NOT NULL,
  tags TEXT NOT NULL,
  publisher TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5 (name UNINDEXED, words, description, tokenize = '${TOKENIZE}');
`;

const BUSY_MS = 15_000;

export class LocalDb {
  readonly db: DatabaseSync;
  // True when the search index was dropped because its tokenizer changed: the catalog rebuilds it from the versions.
  readonly indexReset: boolean;

  constructor(file: string) {
    this.db = new DatabaseSync(file, { timeout: BUSY_MS });
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.indexReset = this.immediate(() => {
      const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_fts'").get() as { sql: string } | undefined;
      const stale = fts !== undefined && !fts.sql.includes(`'${TOKENIZE}'`);
      if (stale) this.db.exec('DROP TABLE search_fts; DELETE FROM search_cards;');
      this.db.exec(SCHEMA);
      return stale;
    });
  }

  // Runs fn inside BEGIN IMMEDIATE ... COMMIT; rolls back if it throws. Nested calls join the outer transaction.
  immediate<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw e;
    }
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}

// The platform check (contract §8): the search needs FTS5 compiled into node:sqlite.
export function fts5Works(): boolean {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5 (x); INSERT INTO t VALUES ('release notes')");
    const row = db.prepare("SELECT count(*) AS n FROM t WHERE t MATCH 'notes'").get() as { n: number };
    return row.n === 1;
  } catch {
    return false;
  } finally {
    db.close();
  }
}
