// The discovery golden set, measured at the interface (golden/queries.yaml METRICS, any-word mode): Found,
// Findable, Nothing matches. The labels are oracles; a disagreement is a finding to re-read, never a label to change.

import { describe, expect, it } from 'vitest';
import { COMMON_WORDS } from '../src/words.ts';
import type { Catalog } from '../src/catalog.ts';
import { discoveryCorpus } from './corpus.ts';
import { loadGolden } from './golden.ts';
import { openTest } from './helpers.ts';

const q = loadGolden('queries.yaml');
const byId = new Map<string, any>(q.queries.map((x: any) => [x.id, x]));

function seeded(): Catalog {
  const { catalog } = openTest();
  for (const s of discoveryCorpus()) catalog.publish({ name: s.name, files: s.files }, 'ana');
  return catalog;
}

function top5(catalog: Catalog, term: string): string[] {
  const page = catalog.search({ query: term, limit: 5 });
  for (const c of page.results) expect(c.name && c.description, term).toBeTruthy();
  return page.results.map((c) => c.name);
}

describe('discovery (golden/queries.yaml, any-word mode)', () => {
  it('the common-word list is exactly the golden one', () => {
    expect([...COMMON_WORDS]).toEqual(q.common_words);
  });

  it('Found: every must_find is in the top 5 of at least one term, for the whole any-word gate set (recall@5 = 1.0)', () => {
    const catalog = seeded();
    let labelled = 0;
    let found = 0;
    const misses: string[] = [];
    for (const id of q.sets['keyword-gate-any']) {
      const query = byId.get(id);
      const tops = query.keywords.map((k: string) => top5(catalog, k));
      for (const name of query.must_find) {
        labelled++;
        if (tops.some((t: string[]) => t.includes(name))) found++;
        else misses.push(`${id} ${name} (${query.keywords.join(' | ')})`);
      }
    }
    console.info(`discovery Found: recall@5 ${found}/${labelled}`);
    expect(misses).toEqual([]);
  });

  it('Findable: each semantic-gap query\'s reformulation finds it; its keywords are the reported gap', () => {
    const catalog = seeded();
    const gap: string[] = [];
    for (const id of q.sets['semantic-gap-any']) {
      const query = byId.get(id);
      const tops = top5(catalog, query.reformulation);
      for (const name of query.must_find) expect(tops, `${id} ${query.reformulation}`).toContain(name);
      if (!query.keywords.some((k: string) => query.must_find.every((n: string) => top5(catalog, k).includes(n)))) gap.push(id);
    }
    console.info(`discovery known gap (keywords alone miss): ${gap.join(', ')}`);
  });

  it('Nothing matches: every no-match term says partial or none, and no card has every content word', () => {
    const catalog = seeded();
    const leaking: string[] = [];
    for (const id of q.sets['no-match']) {
      for (const term of byId.get(id).keywords) {
        const page = catalog.search({ query: term });
        expect(['partial', 'none'], `${id} "${term}"`).toContain(page.match);
        if (page.results.length) leaking.push(`${id} "${term}" → ${page.results[0]!.name} (${page.results[0]!.matched_words.join(', ')})`);
      }
    }
    console.info(`no-match terms with partial cards: ${leaking.length ? leaking.join('; ') : 'none'}`);
  });
});
