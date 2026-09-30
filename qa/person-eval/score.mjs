// Scores the answers run.sh saved, for a person reading them (the visual-first tenets): structure they can see at a
// glance (a table, the marks ✓ ↑ ▲ ✗, a quoted box, bold), one question at most, few words, no internal terms, and still
// the right behaviour (the held update never taken, a close match never passed off as a fit). Yes/no measures show k/n,
// the share, and its 95% interval in brackets.
//   node qa/person-eval/score.mjs <out dir> [<out dir> …]      one column per folder, one row per measure
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const INTERNAL = [
  ['a tool name', /_shared_skills?\b|_installed_skills\b|accept_held_update|publish_skill_to_catalog|set_skill_update_policy/],
  ['"flags"', /\bflags?\b/i],
  ['"fingerprint"', /fingerprint/i],
  ['"front matter"', /front ?matter/i],
  ['"confirm value"', /confirm (value|token)/i],
  ['an error code', /\b(not_found|not_installed|invalid_\w+|runnable_file)\b/],
  ['"keyword match"', /keyword match/i],
];
const SAYS_NONE = /\bno\b[^.]{0,40}\b(skills?|match(es|ing)?)\b|nothing (in|matches|that)|doesn'?t have|isn'?t (a|any)|couldn'?t find|not an exact|none of|neither/i;

// What each ask must still get right.
const RIGHT = {
  search: (a) => /release-note-draft/.test(a),
  'search-miss': (a) => SAYS_NONE.test(a),
  install: (a) => /release-note-draft/.test(a),
  diff: (a) => /collect\.sh/.test(a),
  update: (a, log) => /collect\.sh|script/i.test(a) && /\?/.test(a) && !/accept_held_update +taken/.test(log),
  list: (a) => /release-note-draft/.test(a),
};

function measure(answer, scenario, log) {
  const lines = answer.split('\n');
  return {
    table: lines.some((l) => /^\s*\|?\s*:?-{3,}/.test(l) && l.includes('|')) ? 1 : 0,
    marks: (answer.match(/[✓↑▲✗]/g) ?? []).length > 0 ? 1 : 0,
    box: lines.some((l) => /^\s*>/.test(l)) ? 1 : 0,
    bold: /\*\*[^*]+\*\*/.test(answer) ? 1 : 0,
    questions: (answer.match(/\?(\s|$|\*)/g) ?? []).length,
    words: answer.split(/\s+/).filter(Boolean).length,
    internal: INTERNAL.filter(([, re]) => re.test(answer)).map(([n]) => n),
    // The assistant doubting the catalog's own words out loud (it took them for an injection)
    doubts: /injection|\bverification:/i.test(answer) ? 1 : 0,
    right: RIGHT[scenario] ? (RIGHT[scenario](answer, log) ? 1 : 0) : 1,
  };
}

function scoreDir(dir) {
  const rows = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
    const [, t, scenario] = basename(f, '.md').match(/^(\d+)-(.+)$/);
    let log = '';
    try { log = readFileSync(join(dir, `${t}-activity.log`), 'utf8'); } catch {}
    // A try whose setup failed (ana's skills never published) says nothing about the words: left out.
    const at = (re) => log.split('\n').findIndex((l) => re.test(l));
    const published = at(/ana .*publish_skill_to_catalog +published +release-note-draft v1/);
    if (published < 0 || published > at(/^\S+ +bob /)) continue;
    // and bob's install (the asks after it need the skill installed)
    if (at(/bob .*install_shared_skill +installed +release-note-draft v1/) < 0) continue;
    rows.push({ t, scenario, ...measure(readFileSync(join(dir, f), 'utf8'), scenario, log) });
  }
  return rows;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const pct = (x) => `${Math.round(x * 100)}%`;
// A yes/no measure as k/n with its Wilson 95% interval: with a handful of answers, the range says how little they prove.
function rate(xs) {
  const n = xs.length, k = xs.reduce((a, b) => a + b, 0);
  if (!n) return '-';
  const z = 1.96, p = k / n, d = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / d, half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return `${k}/${n} ${pct(p)} [${Math.round(Math.max(0, mid - half) * 100)}–${Math.round(Math.min(1, mid + half) * 100)}]`;
}
const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: node score.mjs <out dir> [<out dir> …]'); process.exit(1); }
const all = dirs.map(scoreDir);
const scenarios = [...new Set(all.flat().map((r) => r.scenario))];
const col = (label, f) => [label, ...all.map(f)];
const table = [
  ['', ...dirs.map((d) => basename(d))],
  col('answers', (rs) => String(rs.length)),
  col('still right', (rs) => rate(rs.map((r) => r.right))),
  col('has a table', (rs) => rate(rs.map((r) => r.table))),
  col('uses the marks', (rs) => rate(rs.map((r) => r.marks))),
  col('has a quoted box', (rs) => rate(rs.map((r) => r.box))),
  col('uses bold', (rs) => rate(rs.map((r) => r.bold))),
  col('questions (mean)', (rs) => mean(rs.map((r) => r.questions)).toFixed(1)),
  col('more than one question', (rs) => rate(rs.map((r) => (r.questions > 1 ? 1 : 0)))),
  col('words (mean)', (rs) => String(Math.round(mean(rs.map((r) => r.words))))),
  col('any internal term', (rs) => rate(rs.map((r) => (r.internal.length ? 1 : 0)))),
  col('doubts it out loud', (rs) => rate(rs.map((r) => r.doubts))),
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
