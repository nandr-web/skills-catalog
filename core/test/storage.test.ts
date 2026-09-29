// Storage tests (golden/histories.yaml `concurrent` and `fault`): nothing lost across processes, a refused or failed
// publish leaves no version behind, and no version ever points at a missing blob.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, rmSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SearchIndex, Storage } from '../src/ports.ts';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import { FolderBlobStore } from '../src/local/blobs.ts';
import type { SqliteMetadataStore } from '../src/local/metadata.ts';
import { historyVersion, loadGolden, type RawFile } from './golden.ts';
import { counterIds, errorOf, fixedClock, openTest, request, versionsIn } from './helpers.ts';
import { sandbox } from './sandbox.ts';

const histories = loadGolden('histories.yaml');
const ana = actAs('ana');

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${err}`))));
  });
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

function storedBlobs(dir: string): Set<string> {
  return new Set(
    readdirSync(join(dir, 'catalog', 'blobs'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => basename(d.parentPath) + d.name),
  );
}

function renamed(files: RawFile[], name: string): RawFile[] {
  return files.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.from(Buffer.from(f.bytes).toString().replace('pr-review-checklist', name)) } : f));
}

// Another publish lands just before this catalog's next commit (after its pre-checks).
function raceBeforeCommit(rival: () => Promise<void>): (s: Storage) => Storage {
  let armed = true;
  return (s) =>
    Object.assign(Object.create(s), {
      commit: async (...args: Parameters<Storage['commit']>) => {
        if (armed) {
          armed = false;
          await rival();
        }
        return s.commit(...args);
      },
    });
}

describe('nothing lost (histories.concurrent)', () => {
  it('20 publishes of one name from 20 processes become versions 1..20, no gaps, each retrievable', async () => {
    const dir = join(sandbox(), 'catalog');
    (await openLocalCatalog(dir)).close(); // create the schema once, so the race is only on publishing
    const script = join(import.meta.dirname, 'fixtures', 'publish-one.ts');
    const startAt = Date.now() + 1500;
    const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => run([script, dir, String(i + 1), String(startAt)])));
    const results = outs.map((o) => JSON.parse(o) as { n: number; version: number; created: boolean; fingerprint: string });
    expect(results.every((r) => r.created)).toBe(true);
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const catalog = await openLocalCatalog(dir);
    try {
      for (const r of results) {
        const got = await catalog.fetch({ name: 'concurrent-skill', version: r.version });
        expect(got.fingerprint).toBe(r.fingerprint);
        expect(Buffer.from(got.files.find((f) => f.path === 'SKILL.md')!.content_base64, 'base64').toString()).toContain(`Variant ${r.n}.`);
      }
      expect((await catalog.versions({ name: 'concurrent-skill' })).latest).toBe(20);
    } finally {
      catalog.close();
    }
  }, 30_000);
});

describe('fault injection (histories.fault)', () => {
  it('the version append fails after the blobs were stored: an error, no version, not searchable; the retry succeeds', async () => {
    let failNext = true;
    const { dir, catalog } = await openTest({
      wrapMeta: (m: SqliteMetadataStore) =>
        Object.assign(Object.create(m), {
          append: (...args: Parameters<SqliteMetadataStore['append']>) => {
            if (failNext) {
              failNext = false;
              throw new Error('injected: disk full');
            }
            return m.append(...args);
          },
        }),
    });
    const v1 = renamed(historyVersion(histories.versions['prc.v1']), 'fault-skill');
    await expect(catalog.publish(request('fault-skill', v1), ana)).rejects.toThrow(/injected/);
    expect(versionsIn(dir, 'fault-skill')).toEqual([]);
    expect((await catalog.search({ query: 'checklist' })).results).toEqual([]);
    expect((await errorOf(() => catalog.read({ name: 'fault-skill' }))).code).toBe('not_found');
    expect(await catalog.publish(request('fault-skill', v1), ana)).toMatchObject({ created: true, version: 1 });
    expect((await catalog.fetch({ name: 'fault-skill', version: 1 })).files).toHaveLength(2);
  });

  it('a publish that loses the race at its commit point takes back the blobs it added: storage is exactly as it was', async () => {
    const dir = sandbox();
    const { catalog } = await openTest(
      {
        wrapStorage: raceBeforeCommit(async () => {
          const bo = await openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds() });
          await bo.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v2'])), actAs('bo'));
          bo.close();
        }),
      },
      dir,
    );
    const e = await errorOf(() => catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v3'])), ana));
    expect(e.code).toBe('not_owner');
    expect(e.data['owners']).toEqual(['bo']);
    const referenced = new Set((await catalog.fetch({ name: 'pr-review-checklist', version: 1 })).files.map((f) => sha(Buffer.from(f.content_base64, 'base64'))));
    expect(storedBlobs(dir)).toEqual(referenced);
  });

  it('two publishes with the same expected_latest race: one lands, the other is conflict; the blob they share survives', async () => {
    const dir = sandbox();
    const base = historyVersion(histories.versions['prc.v1']);
    const variant = (n: string) => base.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from(`Variant ${n}.\n`)]) } : f));
    const setup = await openTest({}, dir);
    for (let n = 1; n <= 21; n++) await setup.catalog.publish(request('pr-review-checklist', variant(String(n))), ana);
    setup.catalog.close();
    const { catalog } = await openTest(
      {
        wrapStorage: raceBeforeCommit(async () => {
          const rival = await openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds() });
          expect(await rival.publish(request('pr-review-checklist', variant('rival'), { expected_latest: 21 }), ana)).toMatchObject({ created: true, version: 22 });
          rival.close();
        }),
      },
      dir,
    );
    const e = await errorOf(() => catalog.publish(request('pr-review-checklist', variant('loser'), { expected_latest: 21 }), ana));
    expect(e.code).toBe('conflict');
    expect(e.data['latest']).toBe(22);
    const referenced = new Set<string>();
    for (let v = 1; v <= 22; v++) {
      for (const f of (await catalog.fetch({ name: 'pr-review-checklist', version: v })).files) referenced.add(sha(Buffer.from(f.content_base64, 'base64')));
    }
    expect(storedBlobs(dir)).toEqual(referenced);
  });

  it('the search index fails once: the publish still succeeds, and the next search catches up from the outbox', async () => {
    let failNext = true;
    const { catalog } = await openTest();
    const index = (catalog as any).p.index as SearchIndex;
    const upsert = index.upsert.bind(index);
    index.upsert = async (card) => {
      if (failNext) {
        failNext = false;
        throw new Error('injected: index write failed');
      }
      await upsert(card);
    };
    expect(await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana)).toMatchObject({ created: true, version: 1 });
    expect((await catalog.search({ query: 'checklist' })).results.map((c) => c.name)).toEqual(['pr-review-checklist']);
  });

  it('opening the catalog removes unreferenced blobs older than an hour, and never a referenced one', async () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    const first = await openLocalCatalog(root);
    await first.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana);
    first.close();
    // A crashed publish's leftover: bytes stored, no version points at them.
    const orphan = Buffer.from('left by a crash\n');
    const blobs = new FolderBlobStore(root, counterIds());
    blobs.put(sha(orphan), orphan);
    const at = (minutes: number) => ({ now: () => new Date(Date.now() + minutes * 60_000) });
    (await openLocalCatalog(root, { clock: at(59) })).close();
    expect(blobs.has(sha(orphan))).toBe(true);
    expect(storedBlobs(dir).size).toBe(3);
    (await openLocalCatalog(root, { clock: at(61) })).close();
    expect(blobs.has(sha(orphan))).toBe(false);
    expect(storedBlobs(dir).size).toBe(2);
    const reopened = await openLocalCatalog(root, { clock: at(24 * 60) });
    expect((await reopened.fetch({ name: 'pr-review-checklist', version: 1 })).files).toHaveLength(2);
    reopened.close();
  });

  it('a blob cleaned away between the put and the commit is put back under the lock: no version points at a missing blob', async () => {
    const dir = sandbox();
    let armed = false;
    let swept = false;
    const { catalog } = await openTest(
      {
        wrapMeta: (m: SqliteMetadataStore) =>
          Object.assign(Object.create(m), {
            withWriteLock: <T,>(fn: () => T): T => {
              if (armed && !swept) {
                swept = true; // an over-eager cleanup in another process, just before this commit
                rmSync(join(dir, 'catalog', 'blobs'), { recursive: true, force: true });
              }
              return m.withWriteLock(fn);
            },
          }),
      },
      dir,
    );
    armed = true;
    expect(await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana)).toMatchObject({ created: true, version: 1 });
    expect(swept).toBe(true);
    expect((await catalog.fetch({ name: 'pr-review-checklist', version: 1 })).files).toHaveLength(2);
  });

  it('if putting the missing blob back fails too, no version is stored, and a retry lands', async () => {
    const dir = sandbox();
    let phase: 'open' | 'armed' | 'failing' | 'done' = 'open';
    const { catalog } = await openTest(
      {
        wrapMeta: (m: SqliteMetadataStore) =>
          Object.assign(Object.create(m), {
            withWriteLock: <T,>(fn: () => T): T => {
              if (phase === 'armed') {
                phase = 'failing';
                rmSync(join(dir, 'catalog', 'blobs'), { recursive: true, force: true });
              }
              return m.withWriteLock(fn);
            },
          }),
        wrapBlobs: (b: FolderBlobStore) =>
          Object.assign(Object.create(b), {
            put: (s: string, bytes: Uint8Array) => {
              if (phase === 'failing') {
                phase = 'done';
                throw new Error('injected: re-put failed');
              }
              return b.put(s, bytes);
            },
          }),
      },
      dir,
    );
    phase = 'armed';
    const v1 = historyVersion(histories.versions['prc.v1']);
    await expect(catalog.publish(request('pr-review-checklist', v1), ana)).rejects.toThrow(/re-put failed/);
    expect(versionsIn(dir, 'pr-review-checklist')).toEqual([]);
    expect(await catalog.publish(request('pr-review-checklist', v1), ana)).toMatchObject({ created: true, version: 1 });
    expect((await catalog.fetch({ name: 'pr-review-checklist', version: 1 })).files).toHaveLength(2);
  });

  it('putting a blob that already exists refreshes its time, so the age-based cleanup spares it', () => {
    const root = join(sandbox(), 'catalog');
    const blobs = new FolderBlobStore(root, counterIds());
    const bytes = Buffer.from('shared\n');
    blobs.put(sha(bytes), bytes);
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(root, 'blobs', sha(bytes).slice(0, 2), sha(bytes).slice(2)), old, old);
    expect(blobs.put(sha(bytes), bytes)).toBe(false);
    expect(blobs.storedAt(sha(bytes))!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('the index is rebuildable from the versions at any time', async () => {
    const { catalog } = await openTest();
    await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana);
    await catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), actAs('bo'));
    const before = await catalog.search({});
    await catalog.rebuildIndex();
    expect(await catalog.search({})).toEqual(before);
  });
});
