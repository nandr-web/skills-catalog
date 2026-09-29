// Which stored versions name a file, as a table the local catalog keeps beside the versions (contract §1.1, the files
// route): written in the same commit as the version, so a file is named the moment its version is; made and filled from
// the versions at a catalog's first writing open, in one transaction; read as it is by a read-only open, which looks
// through the versions instead when an older catalog doesn't have it yet. Removing a file never trusts it alone.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import type { Storage } from '../src/ports.ts';
import { sha256Hex } from '../src/skill-tree/index.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { errorOf, openTest, request } from './helpers.ts';
import { sandbox } from './sandbox.ts';

const histories = loadGolden('histories.yaml');
const NAME = 'pr-review-checklist';
const files = (v: string) => historyVersion(histories.versions[v]);
const ana = actAs('ana');

type Row = { sha256: string; name: string; version: number };

function withDb<T>(root: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(join(root, 'catalog.sqlite'));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}
const rows = (root: string): Row[] =>
  withDb(root, (db) => db.prepare('SELECT sha256, name, version FROM version_files ORDER BY name, version, sha256').all() as unknown as Row[]);
const hasTable = (root: string): boolean =>
  withDb(root, (db) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'version_files'").get() !== undefined);
const storageOf = (c: unknown) => (c as { p: { storage: Storage } }).p.storage;
const expected = (list: [string, number, { bytes: Uint8Array }[]][]): Row[] =>
  list
    .flatMap(([name, version, fs]) => [...new Set(fs.map((f) => sha256Hex(f.bytes)))].map((sha256) => ({ sha256, name, version })))
    .sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.sha256.localeCompare(b.sha256));

// Two versions of one skill and one of another; prc.v2 shares a file with prc.v1.
async function catalogWithVersions() {
  const dir = sandbox();
  const root = join(dir, 'catalog');
  const c = await openLocalCatalog(root);
  await c.publish(request(NAME, files('prc.v1')), ana);
  await c.publish(request(NAME, files('prc.v2')), ana);
  const twice = { path: 'notes/again.md', mode: '0644' as const, bytes: files('prc.v1').find((f) => f.path !== 'SKILL.md')!.bytes };
  await c.publish(request('second-skill', [...files('prc.v1').map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.from(Buffer.from(f.bytes).toString().replace(NAME, 'second-skill')) } : f)), twice]), ana);
  c.close();
  const second = withDb(root, (db) => JSON.parse((db.prepare("SELECT files FROM versions WHERE name = 'second-skill'").get() as { files: string }).files) as { sha256: string }[]);
  return { root, second };
}

describe('the table of which versions name a file (local)', () => {
  it('a publish writes one row per distinct file of its version, in its commit; a file named twice is one row', async () => {
    const { root, second } = await catalogWithVersions();
    const want = [
      ...expected([
        [NAME, 1, files('prc.v1')],
        [NAME, 2, files('prc.v2')],
      ]),
      ...[...new Set(second.map((f) => f.sha256))].map((sha256) => ({ sha256, name: 'second-skill', version: 1 })),
    ].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version || a.sha256.localeCompare(b.sha256));
    expect(second.length).toBeGreaterThan(new Set(second.map((f) => f.sha256)).size); // the version names a file twice
    expect(rows(root)).toEqual(want);
  });

  it('a file is named the moment its version is stored; a refused publish writes no row', async () => {
    const { catalog, dir } = await openTest();
    const root = join(dir, 'catalog');
    await catalog.publish(request(NAME, files('prc.v1')), ana);
    for (const f of files('prc.v1')) expect(await storageOf(catalog).fileState(sha256Hex(f.bytes))).toBe('named');
    const before = rows(root);
    expect((await errorOf(() => catalog.publish(request(NAME, files('prc.v2')), actAs('bo')))).code).toBe('not_owner');
    expect(rows(root)).toEqual(before);
    catalog.close();
  });

  it('the file route reads the table: a file whose row is gone is unknown there, and the cleanup still keeps it', async () => {
    const { catalog, dir } = await openTest();
    const root = join(dir, 'catalog');
    await catalog.publish(request(NAME, files('prc.v1')), ana);
    catalog.close();
    const kept = sha256Hex(files('prc.v1')[0]!.bytes);
    withDb(root, (db) => {
      db.prepare('DELETE FROM version_files WHERE sha256 = ?').run(kept);
      db.prepare('INSERT INTO pending_blobs (sha256, at) VALUES (?, ?)').run(kept, new Date(Date.now() - 2 * 3600_000).toISOString());
    });
    const c = await openLocalCatalog(root); // its cleanup reads the stale row: the version still names the file
    expect(await storageOf(c).fileState(kept)).toBe('unknown');
    expect((await c.fetch({ name: NAME, version: 1 })).files).toHaveLength(files('prc.v1').length);
    c.close();
  });

  it('an older catalog gets the table filled from its versions at its first writing open; a read-only open looks through the versions and writes nothing', async () => {
    const { root } = await catalogWithVersions();
    const whole = rows(root);
    withDb(root, (db) => db.exec('DROP TABLE version_files'));
    const ro = await openLocalCatalog(root, { readOnly: true });
    for (const f of files('prc.v2')) expect(await storageOf(ro).fileState(sha256Hex(f.bytes))).toBe('named');
    expect(await storageOf(ro).fileState('0'.repeat(64))).toBe('unknown');
    ro.close();
    expect(hasTable(root)).toBe(false);
    const w = await openLocalCatalog(root);
    w.close();
    expect(rows(root)).toEqual(whole);
  });

  it('a first open that fails part-way through filling the table leaves no table; the next writing open fills it', async () => {
    const { root } = await catalogWithVersions();
    const whole = rows(root);
    withDb(root, (db) => db.exec('DROP TABLE version_files'));
    await expect(
      openLocalCatalog(root, {
        afterFileIndex: () => {
          throw new Error('injected crash');
        },
      }),
    ).rejects.toThrow(/injected crash/);
    expect(hasTable(root)).toBe(false);
    (await openLocalCatalog(root)).close();
    expect(rows(root)).toEqual(whole);
  });

  it('an open that finds the table doesn\'t fill it again', async () => {
    const { root } = await catalogWithVersions();
    let filled = 0;
    (await openLocalCatalog(root, { afterFileIndex: () => filled++ })).close();
    expect(filled).toBe(0);
  });

  it('a version whose file list isn\'t readable is skipped when the table is filled, not a refused open', async () => {
    const { root } = await catalogWithVersions();
    withDb(root, (db) => {
      db.exec('DROP TABLE version_files');
      db.prepare("UPDATE versions SET files = 'not json' WHERE name = 'second-skill'").run();
    });
    (await openLocalCatalog(root)).close();
    expect(new Set(rows(root).map((r) => r.name))).toEqual(new Set([NAME]));
  });
});
