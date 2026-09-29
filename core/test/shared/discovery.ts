// The discovery golden set, measured at the interface (golden/queries.yaml METRICS, any-word mode): Found,
// Findable, Nothing matches. The labels are oracles; a disagreement is a finding to re-read, never a label to change.
// Run on every adapter (test/adapters.ts): the same search results everywhere.

import { describe, expect, it } from 'vitest';
import { COMMON_WORDS } from '../../src/words.ts';
import type { Catalog } from '../../src/catalog.ts';
import { discoveryCorpus } from '../corpus.ts';
import { loadGolden } from '../golden.ts';
import { HEAVY_MS } from '../helpers.ts';
import { openOn, type TestAdapter } from '../adapters.ts';
import { actAs } from '../../src/local/index.ts';

const q = loadGolden('queries.yaml');
const byId = new Map<string, any>(q.queries.map((x: any) => [x.id, x]));

async function seeded(a: TestAdapter): Promise<Catalog> {
  const { catalog } = await openOn(a);
  for (const s of discoveryCorpus()) await catalog.publish({ name: s.name, files: s.files }, actAs('ana'));
  return catalog;
}

async function top5(catalog: Catalog, term: string): Promise<string[]> {
  const page = await catalog.search({ query: term, limit: 5 });
  for (const c of page.results) expect(c.name && c.description, term).toBeTruthy();
  return page.results.map((c) => c.name);
}

async function hasAll(catalog: Catalog, terms: string[], names: string[]): Promise<boolean> {
  for (const t of terms) {
    const top = await top5(catalog, t);
    if (names.every((n) => top.includes(n))) return true;
  }
  return false;
}

export function discoverySuite(a: TestAdapter): void {
  describe(`discovery (golden/queries.yaml, any-word mode) [${a.name}]`, () => {
    it('the common-word list is exactly the golden one', async () => {
      expect([...COMMON_WORDS]).toEqual(q.common_words);
    });

    it('match and matched_words follow the stems and report the query\'s words as typed (golden match_cases)', async () => {
      const catalog = await seeded(a);
      for (const c of q.match_cases as any[]) {
        const page = await catalog.search({ query: c.term });
        expect(page.results[0]!.name, c.term).toBe(c.top);
        expect(page.results[0]!.matched_words, c.term).toEqual(c.matched_words);
        expect(page.match, c.term).toBe(c.match);
      }
    });

    it('Found: every must_find is in the top 5 of at least one term, for the whole any-word gate set (recall@5 = 1.0)', async () => {
      const catalog = await seeded(a);
      let labelled = 0;
      let found = 0;
      const misses: string[] = [];
      for (const id of q.sets['keyword-gate-any']) {
        const query = byId.get(id);
        const tops: string[][] = [];
        for (const k of query.keywords) tops.push(await top5(catalog, k));
        for (const name of query.must_find) {
          labelled++;
          if (tops.some((t: string[]) => t.includes(name))) found++;
          else misses.push(`${id} ${name} (${query.keywords.join(' | ')})`);
        }
      }
      console.info(`discovery Found: recall@5 ${found}/${labelled}`);
      expect(misses).toEqual([]);
    });

    it('Findable: each semantic-gap query\'s reformulation finds it; its keywords are the reported gap', async () => {
      const catalog = await seeded(a);
      const gap: string[] = [];
      for (const id of q.sets['semantic-gap-any']) {
        const query = byId.get(id);
        const tops = await top5(catalog, query.reformulation);
        for (const name of query.must_find) expect(tops, `${id} ${query.reformulation}`).toContain(name);
        if (!(await hasAll(catalog, query.keywords, query.must_find))) gap.push(id);
      }
      console.info(`discovery known gap (keywords alone miss): ${gap.join(', ')}`);
    }, HEAVY_MS);

    it('Nothing matches: every no-match term says partial or none, and no card has every content word', async () => {
      const catalog = await seeded(a);
      const leaking: string[] = [];
      for (const id of q.sets['no-match']) {
        for (const term of byId.get(id).keywords) {
          const page = (await catalog.search({ query: term }));
          expect(['partial', 'none'], `${id} "${term}"`).toContain(page.match);
          if (page.results.length) leaking.push(`${id} "${term}" → ${page.results[0]!.name} (${page.results[0]!.matched_words.join(', ')})`);
        }
      }
      console.info(`no-match terms with partial cards: ${leaking.length ? leaking.join('; ') : 'none'}`);
    });
  });
}
