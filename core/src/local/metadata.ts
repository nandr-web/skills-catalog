// The local storage's metadata half (the contract's MetadataStore row): versions and the latest pointer in SQLite.
// Synchronous, used only inside the local Storage adapter (storage.ts); `append` is the publish's commit point.

import type { CommitResult, NewVersion, SkillRecord, VersionPublished, VersionRecord } from '../ports.ts';
import type { LocalDb } from './db.ts';

interface VersionRow {
  name: string;
  version: number;
  fingerprint: string;
  publisher: string;
  message: string;
  published_at: string;
  files: string;
  description: string;
  tags: string;
  frontmatter: string;
}

function toRecord(r: VersionRow): VersionRecord {
  return {
    name: r.name,
    version: r.version,
    fingerprint: r.fingerprint,
    publisher: r.publisher,
    message: r.message,
    published_at: r.published_at,
    files: JSON.parse(r.files),
    description: r.description,
    tags: JSON.parse(r.tags),
    frontmatter: JSON.parse(r.frontmatter),
  };
}

export class SqliteMetadataStore {
  private readonly local: LocalDb;

  // Whether the catalog has the table of which versions name a file: a writing open always makes it; a read-only open
  // of a catalog from before it looks through the versions instead.
  private readonly indexed: boolean;

  constructor(local: LocalDb) {
    this.local = local;
    this.indexed = local.hasTable('version_files');
  }

  private get db() {
    return this.local.db;
  }

  skill(name: string): SkillRecord | undefined {
    const r = this.db.prepare('SELECT name, owners, latest FROM skills WHERE name = ?').get(name) as
      | { name: string; owners: string; latest: number }
      | undefined;
    return r && { name: r.name, owners: JSON.parse(r.owners), latest: r.latest };
  }

  version(name: string, version: number): VersionRecord | undefined {
    const r = this.db.prepare('SELECT * FROM versions WHERE name = ? AND version = ?').get(name, version) as VersionRow | undefined;
    return r && toRecord(r);
  }

  byFingerprint(fingerprint: string): VersionRecord | undefined {
    const r = this.db.prepare('SELECT * FROM versions WHERE fingerprint = ? ORDER BY name, version LIMIT 1').get(fingerprint) as VersionRow | undefined;
    return r && toRecord(r);
  }

  versions(name: string, offset: number, limit: number): VersionRecord[] {
    const rows = this.db.prepare('SELECT * FROM versions WHERE name = ? ORDER BY version DESC LIMIT ? OFFSET ?').all(name, limit, offset) as unknown as VersionRow[];
    return rows.map(toRecord);
  }

  latestVersions(): VersionRecord[] {
    const rows = this.db.prepare('SELECT v.* FROM versions v JOIN skills s ON s.name = v.name AND s.latest = v.version ORDER BY v.name').all() as unknown as VersionRow[];
    return rows.map(toRecord);
  }

  names(): string[] {
    return (this.db.prepare('SELECT name FROM skills ORDER BY name').all() as { name: string }[]).map((r) => r.name);
  }

  count(): number {
    return (this.db.prepare('SELECT count(*) AS n FROM skills').get() as { n: number }).n;
  }

  // Whether some stored version names this file, for the file route: one lookup in the table the commit writes.
  namesFile(sha256: string): boolean {
    if (!this.indexed) return this.referencesBlob(sha256);
    return this.db.prepare('SELECT 1 FROM version_files WHERE sha256 = ? LIMIT 1').get(sha256) !== undefined;
  }

  // Whether some version names this file, read from the versions themselves: what removing a file goes by, so a row
  // missing from the table can never cost a stored file. A text match first, so only the rows that hold it are parsed.
  referencesBlob(sha256: string): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM versions v, json_each(v.files) f WHERE instr(v.files, ?1) > 0 AND json_extract(f.value, '$.sha256') = ?1 LIMIT 1")
        .get(sha256) !== undefined
    );
  }

  // The files a publish is about to store, marked before it writes them (contract §5.1): what the open-time cleanup
  // reads instead of the blob folder. Cleared by the append that references them, or by the publish's take-back.
  markPending(sha256s: readonly string[], at: string): void {
    const put = this.db.prepare('INSERT OR REPLACE INTO pending_blobs (sha256, at) VALUES (?, ?)');
    this.local.immediate(() => {
      for (const s of sha256s) put.run(s, at);
    });
  }

  clearPending(sha256s: Iterable<string>): void {
    const del = this.db.prepare('DELETE FROM pending_blobs WHERE sha256 = ?');
    for (const s of sha256s) del.run(s);
  }

  pendingBefore(at: string): string[] {
    return (this.db.prepare('SELECT sha256 FROM pending_blobs WHERE at < ? ORDER BY sha256').all(at) as { sha256: string }[]).map((r) => r.sha256);
  }

  withWriteLock<T>(fn: () => T): T {
    return this.local.immediate(fn);
  }

  append(v: NewVersion, cond: { expectedLatest?: number | undefined }, event: (version: number) => VersionPublished): CommitResult {
    return this.local.immediate((): CommitResult => {
      const s = this.skill(v.name);
      if (s && !s.owners.includes(v.publisher)) return { kind: 'not_owner', owners: s.owners };
      const latest = s?.latest ?? 0;
      if (cond.expectedLatest !== undefined && cond.expectedLatest !== latest) return { kind: 'conflict', latest };
      if (s) {
        const current = this.version(v.name, latest);
        if (current && current.fingerprint === v.fingerprint) return { kind: 'identical', record: current };
      }
      const version = latest + 1;
      this.db
        .prepare(
          'INSERT INTO versions (name, version, fingerprint, publisher, message, published_at, files, description, tags, frontmatter) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(v.name, version, v.fingerprint, v.publisher, v.message, v.published_at, JSON.stringify(v.files), v.description, JSON.stringify(v.tags), JSON.stringify(v.frontmatter));
      const named = this.db.prepare('INSERT OR IGNORE INTO version_files (sha256, name, version) VALUES (?, ?, ?)');
      for (const sha of new Set(v.files.map((f) => f.sha256))) named.run(sha, v.name, version);
      if (s) this.db.prepare('UPDATE skills SET latest = ? WHERE name = ?').run(version, v.name);
      else this.db.prepare('INSERT INTO skills (name, owners, latest) VALUES (?, ?, ?)').run(v.name, JSON.stringify([v.publisher]), version);
      this.db.prepare('INSERT INTO outbox (event) VALUES (?)').run(JSON.stringify(event(version)));
      return { kind: 'created', record: { ...v, version } };
    });
  }
}
