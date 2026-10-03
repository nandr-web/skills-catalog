// The local budgets (the QA plan §7) on a generated 10,000-skill catalog: open, publish, search, read and a file by
// its sha256 (the files route: a stored one, and one no version names), p95 over
// 200 calls each, in-process (the MCP server adds its own transport on top). `--files n` gives each skill n files
// (SKILL.md and n-1 notes). Builds the catalog in a fresh folder under the OS temp folder and removes it after;
// `--keep` keeps it, and `--at <folder>` measures a kept one again without building (same --skills and --files). Last,
// once: the first writing open of a catalog from before the table of which versions name a file, which fills it. Then
// the same calls through the MCP server, as an assistant makes them (scripts/perf-mcp.ts; review P15.4).
//
//   node scripts/perf-search.ts [--skills 10000] [--files 1] [--calls 200] [--keep] [--at <folder>]

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import { scaleCorpus } from '../test/corpus.ts';
import { loadGolden } from '../test/golden.ts';
import { mcpSkipReason, mcpTimes } from './perf-mcp.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const SKILLS = arg('skills', 10_000);
const CALLS = arg('calls', 200);
const FILES = arg('files', 1);
// The MCP server's start and an install have no budget in the plan: reported, never failing the run.
const BUDGET = { search: 100, read: 100, publish: 300, file: 50 };

function p95(ms: number[]): number {
  const s = [...ms].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]!;
}

function median(ms: number[]): number {
  const s = [...ms].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
}

async function timed(times: number[], fn: () => Promise<unknown>): Promise<void> {
  const t = performance.now();
  await fn();
  times.push(performance.now() - t);
}

const atIndex = process.argv.indexOf('--at');
const at = atIndex > 0 ? process.argv[atIndex + 1] : undefined;
const dir = at ?? mkdtempSync(join(tmpdir(), 'skills-catalog-perf-'));
const ana = actAs('ana');
let catalog = await openLocalCatalog(join(dir, 'catalog'));
try {
  const corpus = scaleCorpus(SKILLS).map((s) => ({
    ...s,
    files: [...s.files, ...Array.from({ length: FILES - 1 }, (_, j) => ({ path: `notes/${j}.md`, mode: '0644', content_base64: Buffer.from(`Note ${j} of ${s.name}.\n`).toString('base64') }))],
  }));
  const sha = (b64: string) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  const publishMs: number[] = [];
  const t0 = performance.now();
  if (!at) for (const s of corpus) await timed(publishMs, () => catalog.publish({ name: s.name, files: s.files }, ana));
  const buildS = (performance.now() - t0) / 1000;
  // Every CLI call opens the catalog (schema check, outbox delivery, the orphan-blob sweep).
  const openMs: number[] = [];
  for (let i = 0; i < 20; i++) {
    catalog.close();
    await timed(openMs, async () => (catalog = await openLocalCatalog(join(dir, 'catalog'))));
  }
  const q = loadGolden('queries.yaml');
  const terms: string[] = q.queries.flatMap((x: any) => x.keywords);
  const searchMs: number[] = [];
  for (let i = 0; i < CALLS; i++) await timed(searchMs, () => catalog.search({ query: terms[i % terms.length] }));
  const listMs: number[] = [];
  for (let i = 0; i < 20; i++) await timed(listMs, () => catalog.search({}));
  const readMs: number[] = [];
  for (let i = 0; i < CALLS; i++) await timed(readMs, () => catalog.read({ name: corpus[(i * 37) % corpus.length]!.name, include: 'contents' }));
  const namedMs: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const s = corpus[(i * 53) % corpus.length]!;
    await timed(namedMs, () => catalog.file(sha(s.files[i % s.files.length]!.content_base64)));
  }
  const unknownMs: number[] = [];
  for (let i = 0; i < CALLS; i++) await timed(unknownMs, () => catalog.file(createHash('sha256').update(`not stored ${i}`).digest('hex')));
  const rows = [
    ['open (a CLI call pays this once)', p95(openMs), BUDGET.search],
    ['publish', publishMs.length ? p95(publishMs) : undefined, BUDGET.publish],
    ['search (words)', p95(searchMs), BUDGET.search],
    ['search (no words, whole catalog)', p95(listMs), BUDGET.search],
    ['read (contents)', p95(readMs), BUDGET.read],
    ['a file by its sha256 (stored)', p95(namedMs), BUDGET.file],
    ['a file by its sha256 (no version names it)', p95(unknownMs), BUDGET.file],
  ] as const;
  const measured = rows.filter(([, ms]) => ms !== undefined);
  catalog.close();
  const skipMcp = mcpSkipReason();
  const mcp = skipMcp ? undefined : await mcpTimes({ catalogDir: join(dir, 'catalog'), place: mkdtempSync(join(dir, 'mcp-')), names: corpus.map((s) => s.name), terms, calls: CALLS });
  const mcpRows = mcp
    ? ([
        ['through the MCP server: search (words)', p95(mcp.search), BUDGET.search],
        ['through the MCP server: read', p95(mcp.read), BUDGET.read],
      ] as const)
    : [];
  const older = new DatabaseSync(join(dir, 'catalog', 'catalog.sqlite'));
  older.exec('DROP TABLE version_files');
  older.close();
  const t1 = performance.now();
  catalog = await openLocalCatalog(join(dir, 'catalog'));
  const fillMs = performance.now() - t1;
  console.log(`catalog: ${SKILLS} skills of ${FILES} files, ${at ? `kept at ${at}` : `built in ${buildS.toFixed(1)} s`}; ${CALLS} calls each`);
  for (const [what, ms, budget] of measured) console.log(`${ms! <= budget ? 'ok  ' : 'OVER'} ${what}: p95 ${ms!.toFixed(1)} ms (budget ${budget} ms)`);
  for (const [what, ms, budget] of mcpRows) console.log(`${ms <= budget ? 'ok  ' : 'OVER'} ${what}: p95 ${ms.toFixed(1)} ms (budget ${budget} ms)`);
  if (mcp) {
    console.log(`     through the MCP server: start, until initialize is answered: median ${median(mcp.start).toFixed(0)} ms of ${mcp.start.length} (no budget)`);
    console.log(`     through the MCP server: install: p95 ${p95(mcp.install).toFixed(1)} ms of ${mcp.install.length} (no budget)`);
  } else console.log(`skipped: ${skipMcp}`);
  console.log(`once: the first writing open of an older catalog, filling the table of which versions name a file: ${fillMs.toFixed(0)} ms`);
  process.exitCode = [...measured, ...mcpRows].every(([, ms, budget]) => ms! <= budget) ? 0 : 1;
} finally {
  catalog.close();
  // Only a catalog this run built is removed; one given with --at is always kept.
  if (!at && !process.argv.includes('--keep')) rmSync(dir, { recursive: true, force: true });
  else console.log(`kept: ${dir}`);
}
