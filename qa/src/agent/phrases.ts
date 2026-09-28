// The phrasings the scorer matches in an answer (golden/phrases.yaml, the QA plan's; the runner only reads it).
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export type Phrases = Record<'none' | 'not_found' | 'not_a_match_markers', RegExp[]>;

export function loadPhrases(path: string | URL): Phrases {
  const d = parse(readFileSync(path, 'utf8'));
  const list = (k: keyof Phrases) => ((d[k] ?? []) as string[]).map((s) => new RegExp(s, 'i'));
  return { none: list('none'), not_found: list('not_found'), not_a_match_markers: list('not_a_match_markers') };
}

export const says = (p: Phrases, kind: keyof Phrases, text: string) => p[kind].some((r) => r.test(text));

/** Where the first phrase of this kind starts in the text, or -1. */
export function firstAt(p: Phrases, kind: keyof Phrases, text: string): number {
  const at = p[kind].map((r) => text.search(r)).filter((i) => i >= 0);
  return at.length ? Math.min(...at) : -1;
}
