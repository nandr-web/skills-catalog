// The hosted search budgets (docs/requirements.md: search p95 ≤ 300 ms warm, ≤ 1.5 s for the first query after idle;
// review P15.2), measured against the AWS stand-in (moto on this machine), so they are emulator numbers: S3 answers
// from this machine, which makes them a lower bound for AWS, not a measure of it. A search file of --cards cards
// (default 10,000, from the core's seeded scale catalog) goes in a fresh bucket; then:
// - first query: a new function instance (a fresh index object, as after a cold start or idle) opens the catalog and
//   runs one search, --colds times;
// - warm: one instance runs --calls searches.
//
//   npm run perf [-- --cards 10000 --calls 200 --colds 5]

import { performance } from 'node:perf_hooks';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { type SearchCard } from '@skills-catalog/core';
import { openHostedCatalog } from '../src/entries/api.ts';
import { createStores, S3SearchIndex, type Place } from '../src/index.ts';

export const BUDGET = { warm: 300, first: 1500 };

/** Cards for the search file: the core's scale catalog's names and descriptions. */
export async function scaleCards(n: number): Promise<SearchCard[]> {
  const { scaleCorpus } = (await import('../../core/test/corpus.ts')) as { scaleCorpus: (n: number) => { name: string; files: { path: string; content_base64: string }[] }[] };
  return scaleCorpus(n).map((s, i) => {
    const md = Buffer.from(s.files.find((f) => f.path === 'SKILL.md')!.content_base64, 'base64').toString('utf8');
    const description = JSON.parse(/^description: (.*)$/m.exec(md)![1]!) as string;
    return { name: s.name, description, latest_version: 1, tags: [], publisher: `dev${i % 7}`, updated_at: '2026-10-01T00:00:00.000Z' };
  });
}

const p95 = (ms: number[]) => [...ms].sort((a, b) => a - b)[Math.min(ms.length - 1, Math.ceil(0.95 * ms.length) - 1)]!;
const median = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

/** The times in ms: `first` (a fresh instance's open and first search), `warm` (one instance's searches). */
export async function hostedTimes(o: { ddb: DynamoDBClient; s3: S3Client; place: Place; cards: SearchCard[]; terms: string[]; calls: number; colds: number }): Promise<{ first: number[]; warm: number[]; publish: number[]; fileBytes: number }> {
  await createStores(o.ddb, o.s3, o.place);
  await new S3SearchIndex({ s3: o.s3, place: o.place }).rebuild(o.cards);
  const open = () => openHostedCatalog({ ddb: o.ddb, s3: o.s3, place: o.place, clock: { now: () => new Date() }, signIn: { login: async () => undefined }, signInLogins: [] });
  const first: number[] = [];
  for (let i = 0; i < o.colds; i++) {
    const t = performance.now();
    const { catalog } = await open();
    await catalog.search({ query: o.terms[i % o.terms.length]! });
    first.push(performance.now() - t);
    catalog.close();
  }
  const warm: number[] = [];
  const { catalog } = await open();
  try {
    for (let i = 0; i < o.calls; i++) {
      const t = performance.now();
      await catalog.search({ query: o.terms[i % o.terms.length]! });
      warm.push(performance.now() - t);
    }
  } finally {
    catalog.close();
  }
  // A publish's write to the search file (review F1): a card upserted into the whole file, as indexing at publish does.
  const publish: number[] = [];
  const index = new S3SearchIndex({ s3: o.s3, place: o.place });
  for (let i = 0; i < Math.min(5, o.colds); i++) {
    const t = performance.now();
    await index.upsert({ ...o.cards[i % o.cards.length]!, latest_version: 2 });
    publish.push(performance.now() - t);
  }
  return { first, warm, publish, fileBytes: Buffer.byteLength(JSON.stringify({ cards: o.cards })) };
}

export function report(t: { first: number[]; warm: number[]; publish: number[]; fileBytes: number }, cards: number): { lines: string[]; ok: boolean } {
  const warm = p95(t.warm), first = Math.max(...t.first);
  return {
    ok: warm <= BUDGET.warm && first <= BUDGET.first,
    lines: ([
      `emulator numbers (moto on this machine: a lower bound for AWS, not a measure of it); a search file of ${cards} cards, ${(t.fileBytes / 1e6).toFixed(1)} MB`,
      `${warm <= BUDGET.warm ? 'ok  ' : 'OVER'} search, warm: p95 ${warm.toFixed(1)} ms of ${t.warm.length} (budget ${BUDGET.warm} ms)`,
      `${first <= BUDGET.first ? 'ok  ' : 'OVER'} search, the first after a cold start or idle (a new instance opens, then searches): slowest ${first.toFixed(0)} ms, median ${median(t.first).toFixed(0)} ms of ${t.first.length} (budget ${BUDGET.first} ms)`,
      `each search downloads and parses the whole search file again (${(t.fileBytes / 1e6).toFixed(1)} MB), a cost this machine's S3 hides; in AWS, a conditional GET on its ETag would skip it`,
      `${t.publish.length ? `     a publish's own write to the search file (at publish, review F1): median ${median(t.publish).toFixed(0)} ms of ${t.publish.length} (no budget)` : ''}`,
      'not measured here: Lambda\'s own start and the Parameter Store reads (only in AWS: the smoke test\'s timings)',
    ]).filter(Boolean),
  };
}

if (import.meta.main) {
  const arg = (name: string, fallback: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
  };
  const CARDS = arg('cards', 10_000);
  const { startEmulator, FAKE } = await import('../test/emulator.ts');
  const emu = await startEmulator();
  try {
    const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu.endpoint });
    const s3 = new S3Client({ ...FAKE, endpoint: emu.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
    const cards = await scaleCards(CARDS);
    const terms = ['release notes', 'sql migration', 'pdf form', 'kubernetes deploy', 'accessibility audit', 'incident review'];
    const t = await hostedTimes({ ddb, s3, place: { table: 'perf', bucket: 'perf' }, cards, terms, calls: arg('calls', 200), colds: arg('colds', 5) });
    const r = report(t, CARDS);
    for (const l of r.lines) console.log(l);
    process.exitCode = r.ok ? 0 : 1;
  } finally {
    await emu.stop();
  }
}
