// The discovery golden set's scores (golden/queries.yaml METRICS and "Asks"), measured on a seeded catalog: one place
// computes them, so the discovery suite gates them and `npm run search-score` prints and keeps them per run (the owner's
// "measure and improve the system over time", requirements/skill-search-measure.yaml). The labels are oracles; nothing
// here changes one.

import type { Catalog } from '../src/catalog.ts';
import { contentWords } from '../src/words.ts';
import { loadGolden } from './golden.ts';

export interface AskScore {
  id: string;
  ask: string;
  found: boolean; // every must_find in the top 5
  shown_as_match: boolean; // every must_find there and sharing every word the search kept (not "closest")
  page: string; // the page's match
  top: string[];
}

export interface SearchScores {
  keywords: { found: number; labelled: number }; // Found (recall@5) over the any-word gate set
  asks: { found: number; shown_as_match: number; labelled: number; no_match: number; no_match_labelled: number; misses: string[] };
  per_ask: AskScore[];
}

type Query = { id: string; ask: string; keywords: string[]; must_find: string[] };

/** A card is shown as a match when it shares every word the search kept (the result's own words when it says them). */
export function sharesEvery(result: { query_words?: string[] }, card: { matched_words: string[] }, query: string, common: readonly string[]): boolean {
  const words = result.query_words ?? contentWords(query, common);
  return words.length > 0 && words.every((w) => card.matched_words.includes(w));
}

export async function scoreSearch(catalog: Catalog): Promise<SearchScores> {
  const q = loadGolden('queries.yaml');
  const byId = new Map<string, Query>(q.queries.map((x: Query) => [x.id, x]));
  let found = 0;
  let labelled = 0;
  for (const id of q.sets['keyword-gate-any'] as string[]) {
    const query = byId.get(id)!;
    const tops: string[][] = [];
    for (const k of query.keywords) tops.push((await catalog.search({ query: k, limit: 5 })).results.map((c) => c.name));
    for (const name of query.must_find) {
      labelled++;
      if (tops.some((t) => t.includes(name))) found++;
    }
  }
  // Every developer sentence: the queries' own asks, then the asks written for this metric.
  const asks: { id: string; ask: string; must_find: string[] }[] = [...(q.queries as Query[]), ...((q.asks ?? []) as Query[])];
  const per: AskScore[] = [];
  const a = { found: 0, shown_as_match: 0, labelled: 0, no_match: 0, no_match_labelled: 0, misses: [] as string[] };
  for (const x of asks) {
    const page = await catalog.search({ query: x.ask, limit: 5 });
    const top = page.results.map((c) => c.name);
    const isFound = x.must_find.every((n) => top.includes(n));
    const shown = isFound && x.must_find.every((n) => sharesEvery(page as { query_words?: string[] }, page.results.find((c) => c.name === n)!, x.ask, catalog.config.commonWords));
    per.push({ id: x.id, ask: x.ask, found: isFound, shown_as_match: shown, page: page.match, top });
    if (x.must_find.length === 0) {
      a.no_match_labelled++;
      if (page.match !== 'all') a.no_match++;
      else a.misses.push(`${x.id} shown as a match: ${top[0]}`);
      continue;
    }
    a.labelled += x.must_find.length;
    for (const n of x.must_find) {
      const card = page.results.find((c) => c.name === n);
      if (card) a.found++;
      if (card && sharesEvery(page as { query_words?: string[] }, card, x.ask, catalog.config.commonWords)) a.shown_as_match++;
    }
    if (!isFound) a.misses.push(`${x.id} not in the top 5: ${x.must_find.join(', ')}`);
    else if (!shown) a.misses.push(`${x.id} only as closest: ${x.must_find.join(', ')}`);
  }
  return { keywords: { found, labelled }, asks: a, per_ask: per };
}

export function scoreLines(s: SearchScores): string[] {
  return [
    `keywords (Found, recall@5): ${s.keywords.found}/${s.keywords.labelled}`,
    `asks, found in the top 5: ${s.asks.found}/${s.asks.labelled}`,
    `asks, shown as a match (not "closest"): ${s.asks.shown_as_match}/${s.asks.labelled}`,
    `no-match asks, shown as no match: ${s.asks.no_match}/${s.asks.no_match_labelled}`,
  ];
}
