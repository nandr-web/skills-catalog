// The Storage, SearchIndex and Events ports' shared tests (golden/histories.yaml `concurrent` and `fault`): a refused or
// failed publish leaves no version behind, no version ever points at a missing blob, the index catches up from the
// events, and it's rebuildable from the versions. Run on every adapter (test/adapters.ts).

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SearchIndex, Storage } from '../../src/ports.ts';
import { actAs } from '../../src/local/index.ts';
import { openOn, type TestAdapter } from '../adapters.ts';
import { historyVersion, loadGolden, type RawFile } from '../golden.ts';
import { errorOf, request } from '../helpers.ts';

const histories = loadGolden('histories.yaml');
const ana = actAs('ana');

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

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

export function storageSuite(a: TestAdapter): void {
  describe(`fault injection (histories.fault) [${a.name}]`, () => {
    it('the version append fails after the blobs were stored: an error, no version, not searchable; the retry succeeds', async () => {
      const { store, catalog } = await openOn(a, { failNextAppend: new Error('injected: disk full') });
      const v1 = renamed(historyVersion(histories.versions['prc.v1']), 'fault-skill');
      await expect(catalog.publish(request('fault-skill', v1), ana)).rejects.toThrow(/injected/);
      expect(await store.versionsIn('fault-skill')).toEqual([]);
      expect((await catalog.search({ query: 'checklist' })).results).toEqual([]);
      expect((await errorOf(() => catalog.read({ name: 'fault-skill' }))).code).toBe('not_found');
      expect(await catalog.publish(request('fault-skill', v1), ana)).toMatchObject({ created: true, version: 1 });
      expect((await catalog.fetch({ name: 'fault-skill', version: 1 })).files).toHaveLength(2);
    });

    it('a publish that loses the race at its commit point takes back the blobs it added: storage is exactly as it was', async () => {
      const store = a.store();
      const catalog = await store.open({
        wrapStorage: raceBeforeCommit(async () => {
          const bo = await store.open();
          await bo.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v2'])), actAs('bo'));
          bo.close();
        }),
      });
      const e = await errorOf(() => catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v3'])), ana));
      expect(e.code).toBe('not_owner');
      expect(e.data['owners']).toEqual(['bo']);
      const referenced = new Set((await catalog.fetch({ name: 'pr-review-checklist', version: 1 })).files.map((f) => sha(Buffer.from(f.content_base64, 'base64'))));
      expect(await store.blobs()).toEqual(referenced);
    });

    it('two publishes with the same expected_latest race: one lands, the other is conflict; the blob they share survives', async () => {
      const store = a.store();
      const base = historyVersion(histories.versions['prc.v1']);
      const variant = (n: string) => base.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from(`Variant ${n}.\n`)]) } : f));
      const setup = await store.open();
      for (let n = 1; n <= 21; n++) await setup.publish(request('pr-review-checklist', variant(String(n))), ana);
      setup.close();
      const catalog = await store.open({
        wrapStorage: raceBeforeCommit(async () => {
          const rival = await store.open();
          expect(await rival.publish(request('pr-review-checklist', variant('rival'), { expected_latest: 21 }), ana)).toMatchObject({ created: true, version: 22 });
          rival.close();
        }),
      });
      const e = await errorOf(() => catalog.publish(request('pr-review-checklist', variant('loser'), { expected_latest: 21 }), ana));
      expect(e.code).toBe('conflict');
      expect(e.data['latest']).toBe(22);
      const referenced = new Set<string>();
      for (let v = 1; v <= 22; v++) {
        for (const f of (await catalog.fetch({ name: 'pr-review-checklist', version: v })).files) referenced.add(sha(Buffer.from(f.content_base64, 'base64')));
      }
      expect(await store.blobs()).toEqual(referenced);
    });

    it('the search index fails once: the publish still succeeds, and the next search catches up from the outbox', async () => {
      let failNext = true;
      const { catalog } = await openOn(a);
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

    it('the index is rebuildable from the versions at any time', async () => {
      const { catalog } = await openOn(a);
      await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), ana);
      await catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), actAs('bo'));
      const before = await catalog.search({});
      await catalog.rebuildIndex();
      expect(await catalog.search({})).toEqual(before);
    });
  });
}
