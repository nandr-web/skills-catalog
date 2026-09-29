// The read commands open storage read-only (contract §6, d17d4e78): they never create a catalog, sweep leftovers, deliver
// pending events or rebuild an index, and never write the catalog's data (SQLite may make its own -shm and -wal files
// beside a WAL catalog in a writable folder). Nothing at the default place reads as an empty catalog; a catalog named
// with nothing there is invalid_request not_a_catalog; one that can't be opened is invalid_request catalog_unreadable.

import { chmodSync, existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Catalog } from '../src/catalog.ts';
import { LocalDb, openReadOnly } from '../src/local/db.ts';
import { DB_FILE, actAs, openLocalCatalog } from '../src/local/index.ts';
import { openCatalog } from '../src/open.ts';
import { errorOf, openTest, request } from './helpers.ts';
import { sandbox } from './sandbox.ts';

const skill = (name: string, body = 'Body.\n') => [{ path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from(`---\nname: ${name}\ndescription: The ${name} skill.\n---\n${body}`) }];
// A catalog folder with one skill published, closed.
async function published(): Promise<string> {
  const { dir, catalog } = await openTest();
  await catalog.publish(request('alpha', skill('alpha')), actAs('ana'));
  catalog.close();
  return join(dir, 'catalog');
}
// Every file under a folder with its bytes, except SQLite's own lock and journal files.
function contents(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (!/-(shm|wal)$/.test(e.name)) out[p.slice(dir.length)] = readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}
const readOnly = (dir: string, named = true) => openLocalCatalog(dir, { readOnly: true, named });
async function reads(catalog: Catalog) {
  const found = await catalog.search({ query: 'alpha' });
  return found.results.map((r) => r.name);
}

describe('a read-only open of a catalog that exists', () => {
  it('reads it, and never writes its data', async () => {
    const dir = await published();
    const before = contents(dir);
    const catalog = await readOnly(dir);
    try {
      expect(await reads(catalog)).toEqual(['alpha']);
      expect((await catalog.versions({ name: 'alpha' })).versions.map((v) => v.version)).toEqual([1]);
    } finally {
      catalog.close();
    }
    expect(contents(dir)).toEqual(before);
    // only SQLite's own lock and journal files may appear beside it
    expect(readdirSync(dir).filter((f) => !['catalog.sqlite', 'blobs', 'tmp'].includes(f)).every((f) => /^catalog\.sqlite-(shm|wal)$/.test(f))).toBe(true);
  });

  it('refuses to write through it', async () => {
    const dir = await published();
    const catalog = await readOnly(dir);
    try {
      await expect(catalog.publish(request('beta', skill('beta')), actAs('ana'))).rejects.toThrow();
    } finally {
      catalog.close();
    }
    const again = await readOnly(dir);
    try {
      expect((await again.search({ query: 'beta' })).results).toEqual([]);
    } finally {
      again.close();
    }
  });

  it('never sweeps leftovers, delivers pending events or rebuilds a stale index', async () => {
    const dir = await published();
    // an old leftover in tmp/, a pending event, and a search index made with the tokenizer an older version used
    const leftover = join(dir, 'tmp', 'leftover');
    writeFileSync(leftover, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(leftover, old, old);
    const w = new DatabaseSync(join(dir, DB_FILE));
    w.prepare('INSERT INTO outbox (event) VALUES (?)').run(JSON.stringify({ type: 'version_published', name: 'alpha', version: 1 }));
    w.exec("DROP TABLE search_fts; CREATE VIRTUAL TABLE search_fts USING fts5 (name UNINDEXED, words, description, tokenize = 'unicode61');");
    w.exec("INSERT INTO search_fts (name, words, description) VALUES ('alpha', 'alpha', 'The alpha skill.')");
    w.close();
    const before = contents(dir);
    const catalog = await readOnly(dir);
    try {
      // the stale index is read as it is: every read answers, none writes
      expect(await reads(catalog)).toEqual(['alpha']);
      expect((await catalog.read({ name: 'alpha' })).skills.map((e) => ('error' in e ? e.error.code : e.name))).toEqual(['alpha']);
      expect((await catalog.versions({ name: 'alpha' })).versions).toHaveLength(1);
    } finally {
      catalog.close();
    }
    expect(existsSync(leftover)).toBe(true);
    expect(contents(dir)).toEqual(before);
    const r = new DatabaseSync(join(dir, DB_FILE), { readOnly: true });
    try {
      expect(r.prepare('SELECT count(*) AS n FROM outbox WHERE delivered_at IS NULL').get()).toEqual({ n: 1 });
      expect(String((r.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_fts'").get() as { sql: string }).sql)).toContain("'unicode61'");
    } finally {
      r.close();
    }
  });
});

describe('a read-only open of a catalog file the reads can\'t use', () => {
  // a table the reads query is missing (a foreign or damaged file), or the file is empty: refused as catalog_unreadable
  // when opened, never internal_error on the first read
  for (const table of ['skills', 'versions', 'search_cards', 'search_fts']) {
    it(`without its ${table} table, refuses with catalog_unreadable`, async () => {
      const dir = await published();
      const w = new DatabaseSync(join(dir, DB_FILE));
      w.exec(`DROP TABLE ${table}`);
      w.close();
      const before = contents(dir);
      expect((await errorOf(() => readOnly(dir))).toJSON()).toEqual({ code: 'invalid_request', field: 'catalog', why: 'catalog_unreadable', path: dir });
      expect(contents(dir)).toEqual(before);
    });
  }

  it('empty, refuses with catalog_unreadable', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, DB_FILE), '');
    expect((await errorOf(() => readOnly(dir, false))).toJSON()).toEqual({ code: 'invalid_request', field: 'catalog', why: 'catalog_unreadable', path: dir });
  });

  it('that isn\'t a database, refuses with catalog_unreadable and SQLite\'s code, never its message', async () => {
    const dir = sandbox();
    writeFileSync(join(dir, DB_FILE), 'not a database, and a message a person should never be shown');
    expect((await errorOf(() => readOnly(dir))).toJSON()).toEqual({ code: 'invalid_request', field: 'catalog', why: 'catalog_unreadable', path: dir, sqlite_code: 26 });
  });
});

// A catalog file in someone else's folder is untrusted input (contract §6): SQLite doesn't trust its schema, and the
// tables the reads use must be the catalog's own (real tables, and the search's fts5 table), with no view or trigger
// anywhere in the file, checked before any read, on the read-only open and the writing one alike.
describe('a catalog file made to mislead', () => {
  const crafted = async (sql: string) => {
    const dir = await published();
    const w = new DatabaseSync(join(dir, DB_FILE));
    w.exec(sql);
    w.close();
    return dir;
  };
  const unreadable = (dir: string) => ({ code: 'invalid_request', field: 'catalog', why: 'catalog_unreadable', path: dir });
  const cases: [string, string][] = [
    ['skills is a view', "DROP TABLE skills; CREATE VIEW skills AS SELECT 'alpha' AS name, '[]' AS owners, 1 AS latest"],
    // a view that never ends: reading it would hang the command
    ['search_cards is a view that recurses', 'DROP TABLE search_cards; CREATE VIEW search_cards AS WITH RECURSIVE r(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM r) SELECT n AS name, n AS description, 1 AS latest_version, n AS tags, n AS publisher, n AS updated_at FROM r'],
    ['versions is a view', 'ALTER TABLE versions RENAME TO v2; CREATE VIEW versions AS SELECT * FROM v2'],
    ['search_fts is a plain table', 'DROP TABLE search_fts; CREATE TABLE search_fts (name, words, description)'],
    ['it has a view by another name', 'CREATE VIEW anything AS SELECT 1'],
    ['it has a trigger', "CREATE TRIGGER t AFTER INSERT ON versions BEGIN DELETE FROM skills; END"],
  ];
  for (const [what, sql] of cases) {
    it(`where ${what}, a read-only open refuses with catalog_unreadable and writes nothing`, async () => {
      const dir = await crafted(sql);
      const before = contents(dir);
      expect((await errorOf(() => readOnly(dir))).toJSON()).toEqual(unreadable(dir));
      expect(contents(dir)).toEqual(before);
    });

    it(`where ${what}, the writing open refuses with catalog_unreadable and writes nothing`, async () => {
      const dir = await crafted(sql);
      const before = contents(dir);
      expect((await errorOf(() => openLocalCatalog(dir))).toJSON()).toEqual(unreadable(dir));
      expect(contents(dir)).toEqual(before);
    });
  }

  it('SQLite never trusts the file\'s own schema, on either open', async () => {
    const dir = await published();
    const writing = new LocalDb(join(dir, DB_FILE));
    try {
      expect(writing.db.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 });
    } finally {
      writing.close();
    }
    const reading = openReadOnly(join(dir, DB_FILE));
    try {
      expect(reading.prepare('PRAGMA trusted_schema').get()).toEqual({ trusted_schema: 0 });
    } finally {
      reading.close();
    }
  });

  it('a fresh catalog still opens for writing, its tables made and checked', async () => {
    const fresh = join(sandbox(), 'fresh');
    const catalog = await openLocalCatalog(fresh);
    try {
      await catalog.publish(request('alpha', skill('alpha')), actAs('ana'));
      expect(await reads(catalog)).toEqual(['alpha']);
    } finally {
      catalog.close();
    }
  });
});

describe('a read-only open where there is no catalog', () => {
  it('at the default place, reads as an empty catalog and creates nothing', async () => {
    for (const dir of [join(sandbox(), 'never-made'), sandbox()]) {
      const before = existsSync(dir) ? readdirSync(dir) : null;
      const catalog = await readOnly(dir, false);
      try {
        expect(await reads(catalog)).toEqual([]);
        expect((await errorOf(() => catalog.read({ name: 'alpha' }))).code).toBe('not_found');
      } finally {
        catalog.close();
      }
      expect(existsSync(dir) ? readdirSync(dir) : null).toEqual(before);
    }
  });

  it('at the default place, refuses a write and still creates nothing', async () => {
    const dir = join(sandbox(), 'never-made');
    const catalog = await readOnly(dir, false);
    try {
      await expect(catalog.publish(request('beta', skill('beta')), actAs('ana'))).rejects.toThrow();
      expect(await reads(catalog)).toEqual([]);
    } finally {
      catalog.close();
    }
    expect(existsSync(dir)).toBe(false);
  });

  it('named, refuses with not_a_catalog and its path, and creates nothing', async () => {
    for (const dir of [join(sandbox(), 'typo'), sandbox()]) {
      const before = existsSync(dir) ? readdirSync(dir) : null;
      expect((await errorOf(() => readOnly(dir, true))).toJSON()).toEqual({ code: 'invalid_request', field: 'catalog', why: 'not_a_catalog', path: dir });
      expect((await errorOf(() => openCatalog(pathToFileURL(dir).href, { readOnly: true, named: true }))).toJSON()).toMatchObject({ why: 'not_a_catalog' });
      expect(existsSync(dir) ? readdirSync(dir) : null).toEqual(before);
    }
  });
});

// On macOS and Linux as a person, a folder with no write permission; skipped as root, who writes anyway.
const asRoot = process.getuid?.() === 0;
describe.skipIf(asRoot)('a read-only open of a WAL catalog in a folder that isn\'t writable', () => {
  const locked = async (keepShm: boolean) => {
    const dir = await published();
    let writer: DatabaseSync | undefined;
    if (keepShm) {
      writer = new DatabaseSync(join(dir, DB_FILE));
      writer.prepare('SELECT count(*) FROM skills').get();
    }
    chmodSync(dir, 0o555);
    return {
      dir,
      done: () => {
        chmodSync(dir, 0o755);
        writer?.close();
      },
    };
  };

  it('closed cleanly (no -wal or -shm), reads it without writing anything', async () => {
    const { dir, done } = await locked(false);
    try {
      const before = readdirSync(dir);
      const catalog = await readOnly(dir);
      try {
        expect(await reads(catalog)).toEqual(['alpha']);
      } finally {
        catalog.close();
      }
      expect(readdirSync(dir)).toEqual(before);
    } finally {
      done();
    }
  });

  it('with its -wal and -shm present (a writer has it open), reads it with what the writer wrote', async () => {
    const { dir, done } = await locked(true);
    try {
      const catalog = await readOnly(dir);
      try {
        expect(await reads(catalog)).toEqual(['alpha']);
      } finally {
        catalog.close();
      }
    } finally {
      done();
    }
  });

  it('that can\'t be opened at all, refuses with catalog_unreadable, never internal_error', async () => {
    const dir = await published();
    writeFileSync(join(dir, DB_FILE), 'not a database');
    const e = await errorOf(() => readOnly(dir));
    expect(e.toJSON()).toEqual({ code: 'invalid_request', field: 'catalog', why: 'catalog_unreadable', path: dir });
  });

  it('whose -wal appears after the plain open failed, refuses with catalog_unreadable: the -wal check comes last', async () => {
    const { dir, done } = await locked(false);
    try {
      // a writer opening it in between: its -wal file appears after the plain read-only open failed
      const beforeImmutable = () => {
        chmodSync(dir, 0o755);
        writeFileSync(join(dir, `${DB_FILE}-wal`), '');
        chmodSync(dir, 0o555);
      };
      const e = await errorOf(() => openLocalCatalog(dir, { readOnly: true, named: true, beforeImmutable }));
      expect(e.toJSON()).toEqual({ code: 'invalid_request', field: 'catalog', why: 'catalog_unreadable', path: dir });
    } finally {
      done();
    }
  });
});
