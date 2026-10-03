// The discovery scores on the golden corpus (golden/queries.yaml: Found over the keywords, and the "Asks" metric over
// the developer's own sentences), printed, and kept one JSON line per run in out/search-scores.jsonl, so a change to
// search shows its gain or loss over time (requirements/skill-search-measure.yaml). Builds the catalog in a fresh folder
// under the OS temp folder and removes it after.
//
//   node scripts/search-score.ts [--misses]

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import { discoveryCorpus } from '../test/corpus.ts';
import { scoreLines, scoreSearch } from '../test/search-score.ts';

const dir = mkdtempSync(join(tmpdir(), 'skills-catalog-search-score-'));
const catalog = await openLocalCatalog(join(dir, 'catalog'));
try {
  for (const s of discoveryCorpus()) await catalog.publish({ name: s.name, files: s.files }, actAs('ana'));
  const s = await scoreSearch(catalog);
  for (const line of scoreLines(s)) console.log(line);
  if (process.argv.includes('--misses')) for (const m of s.asks.misses) console.log(`  ${m}`);
  let commit = 'unknown';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: import.meta.dirname, encoding: 'utf8' }).trim();
  } catch {
    // not a checkout: the line says unknown
  }
  const out = join(import.meta.dirname, '..', 'out');
  mkdirSync(out, { recursive: true });
  const line = { at: new Date().toISOString(), commit, keywords: s.keywords, asks: { ...s.asks, misses: undefined } };
  appendFileSync(join(out, 'search-scores.jsonl'), JSON.stringify(line) + '\n');
  console.log(`kept: out/search-scores.jsonl`);
} finally {
  catalog.close();
  rmSync(dir, { recursive: true, force: true });
}
