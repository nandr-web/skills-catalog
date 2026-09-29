// The local budgets (the QA plan §7) on a generated 10,000-skill catalog: publish, search and read, p95 over
// 200 calls each, in-process (the MCP server adds its own transport on top). Builds the catalog in a fresh
// folder under the OS temp folder and removes it after.
//
//   node scripts/perf-search.ts [--skills 10000] [--calls 200] [--keep]

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openLocalCatalog } from '../src/local/index.ts';
import { scaleCorpus } from '../test/corpus.ts';
import { loadGolden } from '../test/golden.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const SKILLS = arg('skills', 10_000);
const CALLS = arg('calls', 200);
const BUDGET = { search: 100, read: 100, publish: 300 };

function p95(ms: number[]): number {
  const s = [...ms].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

const dir = mkdtempSync(join(tmpdir(), 'skills-catalog-perf-'));
let catalog = openLocalCatalog(join(dir, 'catalog'));
try {
  const corpus = scaleCorpus(SKILLS);
  const publishMs: number[] = [];
  const t0 = performance.now();
  for (const s of corpus) {
    const t = performance.now();
    catalog.publish({ name: s.name, files: s.files }, 'ana');
    publishMs.push(performance.now() - t);
  }
  const buildS = (performance.now() - t0) / 1000;
  // Every CLI call opens the catalog (schema check, outbox delivery, the orphan-blob sweep).
  const openMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    catalog.close();
    const t = performance.now();
    catalog = openLocalCatalog(join(dir, 'catalog'));
    openMs.push(performance.now() - t);
  }

  const q = loadGolden('queries.yaml');
  const terms: string[] = q.queries.flatMap((x: any) => x.keywords);
  const searchMs: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const t = performance.now();
    catalog.search({ query: terms[i % terms.length] });
    searchMs.push(performance.now() - t);
  }
  const listMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t = performance.now();
    catalog.search({});
    listMs.push(performance.now() - t);
  }
  const readMs: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const t = performance.now();
    catalog.read({ name: corpus[(i * 37) % corpus.length]!.name, include: 'contents' });
    readMs.push(performance.now() - t);
  }
  const rows = [
    ['open (a CLI call pays this once)', p95(openMs), BUDGET.search],
    ['publish', p95(publishMs), BUDGET.publish],
    ['search (words)', p95(searchMs), BUDGET.search],
    ['search (no words, whole catalog)', p95(listMs), BUDGET.search],
    ['read (contents)', p95(readMs), BUDGET.read],
  ] as const;
  console.log(`catalog: ${SKILLS} skills, built in ${buildS.toFixed(1)} s; ${CALLS} calls each`);
  for (const [what, ms, budget] of rows) console.log(`${ms <= budget ? 'ok  ' : 'OVER'} ${what}: p95 ${ms.toFixed(1)} ms (budget ${budget} ms)`);
  process.exitCode = rows.every(([, ms, budget]) => ms <= budget) ? 0 : 1;
} finally {
  catalog.close();
  if (!process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept: ${dir}`);
}
