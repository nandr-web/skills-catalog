// The local catalog's SQLite file, shared by several processes on one folder (the MCP server, the CLI, serve):
// WAL mode, and every write in BEGIN IMMEDIATE (contract §7), so a writer waits its turn instead of failing.

import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

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
CREATE TABLE IF NOT EXISTS version_files (
  sha256 TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  PRIMARY KEY (sha256, name, version)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS pending_blobs (
  sha256 TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (id) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS reviews (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  reviewer TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (name, version, reviewer)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS search_cards (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  latest_version INTEGER NOT NULL,
  tags TEXT NOT NULL,
  publisher TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  quality TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5 (name UNINDEXED, words, description, tokenize = '${TOKENIZE}');
`;

const BUSY_MS = 15_000;

const isBusy = (e: unknown) => (e as { errcode?: number }).errcode === 5 || /database is locked/.test(String((e as Error).message));
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A catalog file in someone else's folder is untrusted input (contract §6), so every open, reading or writing, first
// turns off SQLite's trust in the file's own schema (trusted_schema off: nothing in it may call a function or virtual
// table SQLite hasn't marked safe) and turns on its defensive mode where the runtime has it. Node 24.15's node:sqlite may
// lack enableDefensive; there, the table checks below are what hold.
function distrust(db: DatabaseSync): void {
  db.exec('PRAGMA trusted_schema = OFF');
  (db as { enableDefensive?: (active: boolean) => void }).enableDefensive?.(true);
}

// Then, from sqlite_master and before any other read, the tables must be the catalog's own: its tables real ones, the
// search's full-text table an fts5 one and the only virtual table, and no view or trigger anywhere in the file (a view
// could stand in for a table, FTS5's own included, and never end; a trigger would run on a write). Names are compared
// as SQLite does, without regard to case. `required` must be there (the read-only open's); any other of the catalog's
// tables may be missing (the writing open makes it) but never wrong.
export class NotCatalogTables extends Error {}
const OWN_TABLES = ['skills', 'versions', 'version_files', 'pending_blobs', 'outbox', 'reviews', 'search_cards'];
const FTS_TABLE = 'search_fts';
const REAL_TABLE = /^CREATE\s+TABLE\s/i;
const FTS5_TABLE = /^CREATE\s+VIRTUAL\s+TABLE\s+("?)search_fts\1\s+USING\s+fts5\s*\(/i;
function checkOwnTables(db: DatabaseSync, required: readonly string[]): void {
  const rows = db.prepare('SELECT type, name, sql FROM sqlite_master').all() as { type: string; name: string; sql: string | null }[];
  const byName = new Map<string, { type: string; sql: string }>();
  for (const r of rows) {
    if (r.type === 'view' || r.type === 'trigger') throw new NotCatalogTables(`a ${r.type}`);
    const sql = r.sql ?? '';
    if (r.type === 'table' && !REAL_TABLE.test(sql) && r.name.toLowerCase() !== FTS_TABLE) throw new NotCatalogTables('a virtual table');
    byName.set(r.name.toLowerCase(), { type: r.type, sql });
  }
  for (const name of [...OWN_TABLES, FTS_TABLE]) {
    const r = byName.get(name);
    if (!r) {
      if (required.includes(name)) throw new NotCatalogTables(`no ${name}`);
      continue;
    }
    if (r.type !== 'table' || !(name === FTS_TABLE ? FTS5_TABLE : REAL_TABLE).test(r.sql)) throw new NotCatalogTables(`${name} isn't the catalog's`);
  }
}

// Fills the table of which versions name a file from the versions themselves, one row per distinct file; a version whose
// file list can't be read is skipped (the file is someone else's input, contract §6).
export const FILL_FILE_INDEX = `INSERT OR IGNORE INTO version_files (sha256, name, version)
  SELECT json_extract(f.value, '$.sha256'), v.name, v.version FROM versions v, json_each(v.files) f
  WHERE json_valid(v.files) AND json_type(v.files) = 'array' AND json_type(f.value, '$.sha256') = 'text'`;

export interface LocalDbOptions {
  // Test seam: runs inside the writing open's transaction right after the table of which versions name a file was made
  // and filled (a crash part-way through).
  afterFileIndex?: () => void;
}

export class LocalDb {
  readonly db: DatabaseSync;
  // True when the search index was dropped because its tokenizer changed: the catalog rebuilds it from the versions.
  readonly indexReset: boolean;
  // True when this open made the reviews table in a catalog that already had versions (one from before reviews were kept):
  // the catalog reviews each skill's latest version once (local/index.ts).
  readonly reviewsAdded: boolean;

  // A path opens a catalog to write: the file is made if missing, switched to WAL and given the schema (':memory:' is an
  // empty one). An open DatabaseSync is read as it is: no WAL switch, schema or index check (the read commands' open).
  constructor(file: string | DatabaseSync, opts: LocalDbOptions = {}) {
    if (file instanceof DatabaseSync) {
      this.db = file;
      this.indexReset = false;
      this.reviewsAdded = false;
      return;
    }
    this.db = new DatabaseSync(file, { timeout: BUSY_MS });
    // An open that fails at any step closes its connection, so it holds nothing (a lock, the WAL) after it throws.
    try {
      this.db.exec(`PRAGMA busy_timeout = ${BUSY_MS}`);
      distrust(this.db);
      checkOwnTables(this.db, []);
      this.walMode();
      this.db.exec('PRAGMA synchronous = NORMAL');
      ({ stale: this.indexReset, reviewsAdded: this.reviewsAdded } = this.schema(opts));
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  // The catalog's tables, made if missing; a search index built with another tokenizer is dropped (the catalog rebuilds
  // it). A catalog from before the table of which versions name a file gets it made and filled here, in this same
  // transaction, so a crash leaves neither and the next writing open does it again. That fill is paid once per older
  // catalog, under the write lock: a few seconds at a very large one (about 7 s cold at 200,000 files), while readers go
  // on and other writers wait within the busy timeout.
  private schema(opts: LocalDbOptions): { stale: boolean; reviewsAdded: boolean } {
    return this.immediate(() => {
      const reviewed = this.hasTable('reviews');
      const fts = this.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_fts'").get() as { sql: string } | undefined;
      const stale = fts !== undefined && !fts.sql.includes(`'${TOKENIZE}'`);
      if (stale) this.db.exec('DROP TABLE search_fts; DELETE FROM search_cards;');
      const indexed = this.hasTable('version_files');
      // A search card's quality (contract §10) came after the first catalogs: an older card table gets the column, empty
      // (its cards show none until the next publish, the offline review run or a rebuild fills it).
      if (this.hasTable('search_cards') && !this.hasColumn('search_cards', 'quality')) this.db.exec('ALTER TABLE search_cards ADD COLUMN quality TEXT');
      this.db.exec(SCHEMA);
      if (!indexed) {
        this.db.exec(FILL_FILE_INDEX);
        opts.afterFileIndex?.();
      }
      const reviewsAdded = !reviewed && this.db.prepare('SELECT 1 FROM versions LIMIT 1').get() !== undefined;
      return { stale, reviewsAdded };
    });
  }

  hasColumn(table: string, column: string): boolean {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
  }

  hasTable(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
  }

  // Switching a fresh file to WAL takes a moment's exclusive lock, and SQLite answers "database is locked" there at
  // once, without waiting, while another process does the same (two assistants, or a server and the CLI, starting
  // together). So it tries again with a short, growing pause, for at most the busy timeout.
  private walMode(): void {
    const until = Date.now() + BUSY_MS;
    for (let pause = 5; ; pause = Math.min(pause * 2, 200)) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL');
        return;
      } catch (e) {
        if (!isBusy(e) || Date.now() + pause > until) throw e;
        sleep(pause + Math.random() * pause);
      }
    }
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

// The read commands' open of a catalog file (contract §6): read-only, never written, its schema and index read as they
// are. A WAL catalog whose folder this user can't write can't have its shared-memory file made, so SQLite refuses to read
// it (SQLITE_READONLY); closed cleanly, with no -wal beside it (checked again right before, since a writer may open it in
// between), no writer of this user's can change it, so it's read as unchanging (immutable=1). Anything else that can't
// be read throws, for the caller to name. `beforeImmutable` is a test seam that runs just before that last check.
// Every table a read queries must be there and the catalog's own, so a file that lacks one fails now rather than on the
// first read.
const SQLITE_READONLY = 8;
const READ_TABLES = ['skills', 'versions', 'search_cards', 'search_fts'];
export function openReadOnly(file: string, beforeImmutable?: () => void): DatabaseSync {
  const readable = (db: DatabaseSync) => {
    try {
      distrust(db);
      checkOwnTables(db, READ_TABLES);
      for (const table of READ_TABLES) db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
      return db;
    } catch (e) {
      db.close();
      throw e;
    }
  };
  try {
    return readable(new DatabaseSync(file, { readOnly: true, timeout: BUSY_MS }));
  } catch (e) {
    if ((((e as { errcode?: number }).errcode ?? 0) & 0xff) !== SQLITE_READONLY) throw e;
    beforeImmutable?.();
    if (existsSync(`${file}-wal`)) throw e;
    const url = pathToFileURL(file);
    url.searchParams.set('immutable', '1');
    return readable(new DatabaseSync(url, { readOnly: true }));
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
