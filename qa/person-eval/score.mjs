// Scores the answers run.sh saved, for a person reading them (what's measured: measure.ts). Yes/no measures show k/n, the
// share, and its 95% interval in brackets. Cost is every trace's in the folder (ana's setup and tries left out included),
// when the run saved traces.
//   node qa/person-eval/score.mjs [--history <file.jsonl>] <out dir> [<out dir> …]
// one column per folder, one row per measure; --history also appends one JSON line per answer to that file.
import { appendFileSync } from 'node:fs';
import { basename } from 'node:path';
import { historyRows, rate, scoreDir } from './measure.ts';

const args = process.argv.slice(2);
let history;
const h = args.indexOf('--history');
if (h >= 0) [, history] = args.splice(h, 2);
const dirs = args;
if (!dirs.length || (h >= 0 && !history)) { console.error('usage: node score.mjs [--history <file.jsonl>] <out dir> [<out dir> …]'); process.exit(1); }

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => `${Math.round(x * 100)}%`;
const usd = (x) => `$${x.toFixed(2)}`;
const scored = dirs.map(scoreDir);
const all = scored.map((s) => s.rows);
const scenarios = [...new Set(all.flat().map((r) => r.scenario))];
const col = (label, f) => [label, ...all.map(f)];
const table = [
  ['', ...dirs.map((d) => basename(d))],
  ['checkout · model', ...scored.map((s) => `${s.meta.sha ?? '?'} · ${s.meta.model ?? '?'}`)],
  col('answers', (rs) => String(rs.length)),
  col('still right', (rs) => rate(rs.map((r) => r.right))),
  col('has a table', (rs) => rate(rs.map((r) => r.table))),
  col('uses the marks', (rs) => rate(rs.map((r) => r.marks))),
  col('has a quoted box', (rs) => rate(rs.map((r) => r.box))),
  col('uses bold', (rs) => rate(rs.map((r) => r.bold))),
  col('questions (mean)', (rs) => mean(rs.map((r) => r.questions)).toFixed(1)),
  col('more than one question', (rs) => rate(rs.map((r) => (r.questions > 1 ? 1 : 0)))),
  col('words (mean)', (rs) => String(Math.round(mean(rs.map((r) => r.words))))),
  col('over its word ceiling', (rs) => rate(rs.map((r) => r.over))),
  col('any internal term', (rs) => rate(rs.map((r) => (r.internal.length ? 1 : 0)))),
  col('doubts it out loud', (rs) => rate(rs.map((r) => r.doubts))),
  ['cost of the run', ...scored.map((s) => (s.costUsd ? usd(s.costUsd) : '-'))],
  col('cost per answer (mean)', (rs) => { const c = rs.map((r) => r.costUsd).filter((x) => x !== undefined); return c.length ? usd(mean(c)) : '-'; }),
];
const widths = table[0].map((_, i) => Math.max(...table.map((r) => r[i].length)));
for (const r of table) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
console.log('\nBy ask (still right · table · marks · box · words):');
for (const s of scenarios) {
  console.log(`  ${s.padEnd(12)} ` + all.map((rs) => {
    const x = rs.filter((r) => r.scenario === s);
    return `${pct(mean(x.map((r) => r.right)))} · ${pct(mean(x.map((r) => r.table)))} · ${pct(mean(x.map((r) => r.marks)))} · ${pct(mean(x.map((r) => r.box)))} · ${Math.round(mean(x.map((r) => r.words)))}w`;
  }).join('   |   '));
}
const terms = all.map((rs) => [...new Set(rs.flatMap((r) => r.internal.map((n) => `${r.scenario}: ${n}`)))]);
dirs.forEach((d, i) => terms[i].length && console.log(`\nInternal terms in ${basename(d)}: ${terms[i].join('; ')}`));
if (history) {
  const now = new Date().toISOString();
  const lines = scored.flatMap((s, i) => historyRows(dirs[i], s, now)).map((r) => JSON.stringify(r) + '\n');
  appendFileSync(history, lines.join(''));
  console.log(`\n${lines.length} answers added to ${history}`);
}
