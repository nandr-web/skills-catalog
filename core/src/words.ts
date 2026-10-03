// How a search query becomes words (contract §2): case-insensitive runs of letters and digits, no stemming; the
// common words are dropped. The list must be exactly the discovery golden set's `common_words` (a test compares them).

export const COMMON_WORDS: readonly string[] = [
  'a', 'an', 'the', 'is', 'there', 'for', 'to', 'of', 'and', 'or', 'my', 'me', 'i', 'skill', 'skills', 'any', 'find', 'get',
  'with', 'in', 'on', 'that', 'this', 'what', 'how', 'can', 'do', 'does', 'help', 'helps',
];

export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// The content words of a query, in order, without repeats. A query made only of common words keeps them all, so
// "skills" still searches for something.
export function contentWords(query: string, common: readonly string[] = COMMON_WORDS): string[] {
  const all = [...new Set(tokens(query))];
  const kept = all.filter((w) => !common.includes(w));
  return kept.length > 0 ? kept : all;
}

// Optimal string alignment distance: insertions, deletions, substitutions and swaps of neighbours.
export function spellingDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

// not_found's suggestions: names within a small spelling distance only (search-based "closest" names misled agents).
export function spelledLike(name: string, names: readonly string[], limit = 3): string[] {
  const max = name.length >= 8 ? 2 : 1;
  return names
    .map((n) => ({ n, d: spellingDistance(name, n, max) }))
    .filter((x) => x.d <= max && x.n !== name)
    .sort((a, b) => a.d - b.d || (a.n < b.n ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.n);
}

// not_found's suggestions, a little wider than spelling (review 2026-10-02): names spelled like it, then names the typed
// name starts as whole words (release-note for release-note-draft), then names made of the same words in another order.
// Still never a search's closest match: every suggestion shares all of the typed name's words, or its spelling.
export function similarNames(name: string, names: readonly string[], limit = 3): string[] {
  const words = name.split('-').filter(Boolean);
  const sorted = (xs: readonly string[]) => [...xs].sort().join('-');
  const prefix = names.filter((n) => n !== name && words.length > 0 && n.startsWith(`${words.join('-')}-`)).sort();
  const reordered = names.filter((n) => n !== name && words.length > 1 && sorted(n.split('-')) === sorted(words)).sort();
  return [...new Set([...spelledLike(name, names, limit), ...prefix, ...reordered])].slice(0, limit);
}
