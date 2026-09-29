// Storage tests (golden/histories.yaml `concurrent` and `fault`): nothing lost across processes, and a failed write
// leaves no version behind.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MetadataStore, SearchIndex } from '../src/ports.ts';
import { openLocalCatalog } from '../src/local/index.ts';
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

  it('the index is rebuildable from the versions at any time', () => {
    const { catalog } = openTest();
    catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), 'ana');
    catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), 'bo');
    const before = catalog.search({});
    catalog.rebuildIndex();
    expect(catalog.search({})).toEqual(before);
  });
});
