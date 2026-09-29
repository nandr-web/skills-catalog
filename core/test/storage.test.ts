// Storage tests (golden/histories.yaml `concurrent` and `fault`): nothing lost across processes, and a failed write
// leaves no version behind.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, rmSync, utimesSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MetadataStore, SearchIndex } from '../src/ports.ts';
import { openLocalCatalog } from '../src/local/index.ts';
import { FolderBlobStore } from '../src/local/blobs.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { counterIds, errorOf, fixedClock, openTest, request, versionsIn } from './helpers.ts';
import { sandbox } from './sandbox.ts';

const histories = loadGolden('histories.yaml');

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

describe('nothing lost (histories.concurrent)', () => {
  it('20 publishes of one name from 20 processes become versions 1..20, no gaps, each retrievable', async () => {
    const dir = join(sandbox(), 'catalog');
    openLocalCatalog(dir).close(); // create the schema once, so the race is only on publishing
    const script = join(import.meta.dirname, 'fixtures', 'publish-one.ts');
    const startAt = Date.now() + 1500;
    const outs = await Promise.all(Array.from({ length: 20 }, (_, i) => run([script, dir, String(i + 1), String(startAt)])));
    const results = outs.map((o) => JSON.parse(o) as { n: number; version: number; created: boolean; fingerprint: string });
    expect(results.every((r) => r.created)).toBe(true);
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const catalog = openLocalCatalog(dir);
    try {
      for (const r of results) {
        const got = catalog.fetch({ name: 'concurrent-skill', version: r.version });
        expect(got.fingerprint).toBe(r.fingerprint);
        expect(Buffer.from(got.files.find((f) => f.path === 'SKILL.md')!.content_base64, 'base64').toString()).toContain(`Variant ${r.n}.`);
      }
      expect(catalog.versions({ name: 'concurrent-skill' }).latest).toBe(20);
    } finally {
      catalog.close();
    }
  }, 30_000);
});

describe('fault injection (histories.fault)', () => {
  it('the version append fails after the blobs were stored: an error, no version, not searchable; the retry succeeds', () => {
    let failNext = true;
    const { dir, catalog } = openTest({
      wrapMeta: (m: MetadataStore): MetadataStore =>
        Object.assign(Object.create(m), {
          append: (...args: Parameters<MetadataStore['append']>) => {
            if (failNext) {
              failNext = false;
              throw new Error('injected: disk full');
            }
            return m.append(...args);
          },
        }),
    });
    const v1 = historyVersion(histories.versions['prc.v1']);
    expect(() => catalog.publish(request('fault-skill', v1.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.from(Buffer.from(f.bytes).toString().replace('pr-review-checklist', 'fault-skill')) } : f))), 'ana')).toThrow(/injected/);
    expect(versionsIn(dir, 'fault-skill')).toEqual([]);
    expect(catalog.search({ query: 'checklist' }).results).toEqual([]);
    expect(errorOf(() => catalog.read({ name: 'fault-skill' })).code).toBe('not_found');
    const renamed = v1.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.from(Buffer.from(f.bytes).toString().replace('pr-review-checklist', 'fault-skill')) } : f));
    expect(catalog.publish(request('fault-skill', renamed), 'ana')).toMatchObject({ created: true, version: 1 });
    expect(catalog.fetch({ name: 'fault-skill', version: 1 }).files).toHaveLength(2);
  });

  it('a publish that loses the race at its commit point takes back the blobs it added: storage is exactly as it was', () => {
    const dir = sandbox();
    let raced = false;
    const other = () => openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds() });
    const { catalog } = openTest(
      {
        wrapMeta: (m: MetadataStore): MetadataStore =>
          Object.assign(Object.create(m), {
            // Another developer's publish lands after the pre-checks and just before the commit takes the lock.
            withWriteLock: <T,>(fn: () => T): T => {
              if (!raced) {
                raced = true;
                const bo = other();
                bo.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v2'])), 'bo');
                bo.close();
              }
              return m.withWriteLock(fn);
            },
          }),
      },
      dir,
    );
    const e = errorOf(() => catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v3'])), 'ana'));
    expect(e.code).toBe('not_owner');
    expect(e.data['owners']).toEqual(['bo']);
    const referenced = new Set(catalog.fetch({ name: 'pr-review-checklist', version: 1 }).files.map((f) => createHash('sha256').update(Buffer.from(f.content_base64, 'base64')).digest('hex')));
    const stored = readdirSync(join(dir, 'catalog', 'blobs'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => basename(d.parentPath) + d.name);
    expect(new Set(stored)).toEqual(referenced);
  });

  it('two publishes with the same expected_latest race: one lands, the other is conflict; the blob they share survives', () => {
    const dir = sandbox();
    const base = historyVersion(histories.versions['prc.v1']);
    const variant = (n: string) => base.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from(`Variant ${n}.\n`)]) } : f));
    let raced = false;
    const { catalog } = openTest(
      {
        wrapMeta: (m: MetadataStore): MetadataStore =>
          Object.assign(Object.create(m), {
            withWriteLock: <T,>(fn: () => T): T => {
              if (!raced && m.skill('pr-review-checklist')?.latest === 21) {
                raced = true;
                const rival = openLocalCatalog(join(dir, 'catalog'), { clock: fixedClock(), ids: counterIds() });
                expect(rival.publish(request('pr-review-checklist', variant('rival'), { expected_latest: 21 }), 'ana')).toMatchObject({ created: true, version: 22 });
                rival.close();
              }
              return m.withWriteLock(fn);
            },
          }),
      },
      dir,
    );
    for (let n = 1; n <= 21; n++) catalog.publish(request('pr-review-checklist', variant(String(n))), 'ana');
    raced = false;
    const e = errorOf(() => catalog.publish(request('pr-review-checklist', variant('loser'), { expected_latest: 21 }), 'ana'));
    expect(e.code).toBe('conflict');
    expect(e.data['latest']).toBe(22);
    const referenced = new Set<string>();
    for (let v = 1; v <= 22; v++) {
      for (const f of catalog.fetch({ name: 'pr-review-checklist', version: v }).files) referenced.add(createHash('sha256').update(Buffer.from(f.content_base64, 'base64')).digest('hex'));
    }
    const stored = readdirSync(join(dir, 'catalog', 'blobs'), { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => basename(d.parentPath) + d.name);
    expect(new Set(stored)).toEqual(referenced);
  });

  it('the search index fails once: the publish still succeeds, and the next search catches up from the outbox', () => {
    let failNext = true;
    const dir = sandbox();
    const { catalog } = openTest({}, dir);
    catalog.close();
    // Reopen with an index that fails its next write, the way a crash between commit and delivery would.
    const flaky = openLocalCatalog(join(dir, 'catalog'), {
      clock: fixedClock(),
      ids: counterIds(),
    });
    const index = (flaky as any).p.index as SearchIndex;
    const upsert = index.upsert.bind(index);
    index.upsert = (card) => {
      if (failNext) {
        failNext = false;
        throw new Error('injected: index write failed');
      }
      upsert(card);
    };
    const v1 = historyVersion(histories.versions['prc.v1']);
    expect(flaky.publish(request('pr-review-checklist', v1), 'ana')).toMatchObject({ created: true, version: 1 });
    expect(flaky.search({ query: 'checklist' }).results.map((c) => c.name)).toEqual(['pr-review-checklist']);
    flaky.close();
  });

  it('opening the catalog removes unreferenced blobs older than an hour, and never a referenced one', () => {
    const dir = sandbox();
    const root = join(dir, 'catalog');
    const first = openLocalCatalog(root);
    first.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), 'ana');
    first.close();
    // A crashed publish's leftover: bytes stored, no version points at them.
    const orphan = Buffer.from('left by a crash\n');
    const sha = createHash('sha256').update(orphan).digest('hex');
    const blobs = new FolderBlobStore(root, counterIds());
    blobs.put(sha, orphan);
    const stored = () => readdirSync(join(root, 'blobs'), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
    const at = (minutes: number) => ({ now: () => new Date(Date.now() + minutes * 60_000) });
    openLocalCatalog(root, { clock: at(59) }).close();
    expect(blobs.has(sha)).toBe(true);
    expect(stored()).toBe(3);
    openLocalCatalog(root, { clock: at(61) }).close();
    expect(blobs.has(sha)).toBe(false);
    expect(stored()).toBe(2);
    const reopened = openLocalCatalog(root, { clock: at(24 * 60) });
    expect(reopened.fetch({ name: 'pr-review-checklist', version: 1 }).files).toHaveLength(2);
    reopened.close();
  });

  it('a blob cleaned away between the put and the commit is put back under the lock: no version points at a missing blob', () => {
    const dir = sandbox();
    let armed = false;
    let swept = false;
    const { catalog } = openTest(
      {
        wrapMeta: (m: MetadataStore): MetadataStore =>
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
    expect(catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), 'ana')).toMatchObject({ created: true, version: 1 });
    expect(swept).toBe(true);
    expect(catalog.fetch({ name: 'pr-review-checklist', version: 1 }).files).toHaveLength(2);
  });

  it('putting a blob that already exists refreshes its time, so the age-based cleanup spares it', () => {
    const root = join(sandbox(), 'catalog');
    const blobs = new FolderBlobStore(root, counterIds());
    const bytes = Buffer.from('shared\n');
    const sha = createHash('sha256').update(bytes).digest('hex');
    blobs.put(sha, bytes);
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(root, 'blobs', sha.slice(0, 2), sha.slice(2)), old, old);
    expect(blobs.put(sha, bytes)).toBe(false);
    expect(blobs.storedAt(sha)!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('the index is rebuildable from the versions at any time', () => {
    const { catalog } = openTest();
    catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), 'ana');
    catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), 'bo');
    const before = catalog.search({});
    catalog.rebuildIndex();
    expect(catalog.search({})).toEqual(before);
  });
});
