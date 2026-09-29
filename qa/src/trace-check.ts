// `qa trace-check` (qa-plan §9; brief §3): every requirement has an automated check; every golden, catalog, query, fixture
// and backlog reference resolves; every backlog item maps to a requirement with a matching phase; every scenario names
// known requirements; the query sets match the queries' own labels; and the hand-written diffs equal `diff -u` on the
// version bytes. A port of the QA plan's preview checker, which it replaces.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

type Doc = Record<string, any>;
const load = (p: string): Doc => parse(readFileSync(p, 'utf8'));

/** The exported requirement list (exported from the design's requirement files), next to the qa package. */
export const DEFAULT_BACKLOG = fileURLToPath(new URL('../../requirements', import.meta.url));
/** The keys a traceability check may have. */
export const CHECK_KEYS = ['layer', 'name', 'golden', 'auto', 'automate_by'];

export function traceCheck({ qa, backlog = DEFAULT_BACKLOG }: { qa: string; backlog?: string }): { problems: string[]; counts: Record<string, number> } {
  const g = Object.fromEntries(['skills', 'histories', 'queries', 'agent-scenarios', 'policy'].map((n) => [n, load(join(qa, 'golden', `${n}.yaml`))]));
  const trace = load(join(qa, 'traceability.yaml'));
  const scenarios: Doc[] = g['agent-scenarios'].scenarios;
  const scen = new Set(scenarios.map((s) => s.id));
  const queries: Doc[] = g.queries.queries;
  const qids = new Set(queries.map((q) => q.id));
  const problems: string[] = [];

  const resolves = (ref: string): boolean => {
    const [head, ...more] = ref.split('.');
    const rest = more.join('.');
    switch (head) {
      case 'skills': { const [top, ...name] = rest.split('.'); return top in g.skills && (!name.length || name.join('.') in (g.skills[top] ?? {})); }
      case 'histories': return rest in g.histories.histories;
      case 'queries': return rest in (g.queries.sets ?? {}) || qids.has(rest) || rest === 'corpus';
      case 'agent': return rest === 'all' || scen.has(rest);
      case 'policy': return rest === 'table';
      case 'scale': return rest === '10k' || rest === '100k';
      default: return false;
    }
  };

  // ---- requirements ----
  for (const r of trace.requirements) {
    if (!r.checks.some((c: Doc) => c.auto)) problems.push(`${r.id}: no automated check`);
    for (const c of r.checks) {
      // A comma in an unquoted flow-mapping name splits it into stray keys: {name: a, b} is {name: a, b: null}.
      const stray = Object.keys(c).filter((k) => !CHECK_KEYS.includes(k));
      if (stray.length) problems.push(`${r.id}: check ${JSON.stringify(c.name)} has the key${stray.length > 1 ? 's' : ''} ${stray.join(', ')}, outside ${CHECK_KEYS.slice(0, -1).join(', ')} and ${CHECK_KEYS.at(-1)} (quote a name that holds a comma)`);
      if (!c.auto && !c.automate_by) problems.push(`${r.id}: manual check without automate_by`);
      for (const ref of c.golden ? String(c.golden).split(/,\s*/) : []) if (!resolves(ref)) problems.push(`${r.id}: golden '${ref}' does not resolve`);
    }
  }

  // ---- scenarios ----
  const versions = new Set(Object.keys(g.histories.versions ?? {}));
  const ats = new Set(Object.values(g.histories.histories as Record<string, Doc>).flatMap((h) => Object.keys(h.at ?? {})));
  const reqIds = new Set(trace.requirements.map((r: Doc) => r.id));
  const catalogOk = (c: string) => ['empty', 'queries.corpus', 'scale.10k'].includes(c) || (c.startsWith('histories.') && c.includes('@') ? ats.has(c.slice('histories.'.length)) : resolves(c));
  for (const s of scenarios) {
    if (s.query && !resolves(s.query)) problems.push(`scenario ${s.id}: query '${s.query}' does not resolve`);
    for (const c of [s.catalog].flat()) if (!catalogOk(String(c))) problems.push(`scenario ${s.id}: catalog '${c}' does not resolve`);
    for (const rule of [...(s.expect ?? []), ...(s.safety ?? [])]) {
      for (const v of Object.values(rule ?? {})) {
        if (v && typeof v === 'object' && 'fixture' in (v as Doc)) {
          const f = String((v as Doc).fixture);
          if (!versions.has(f) && !resolves(f)) problems.push(`scenario ${s.id}: fixture '${f}' does not resolve`);
        }
      }
    }
    for (const r of s.requirement ?? []) if (!reqIds.has(r)) problems.push(`scenario ${s.id}: requirement '${r}' not in traceability`);
    for (const f of Object.values(s.workdir_fixtures ?? {}) as string[]) {
      if (!f.startsWith('product:') && !resolves(f)) problems.push(`scenario ${s.id}: workdir fixture '${f}' does not resolve`);
    }
  }

  // ---- backlog: every item maps to a requirement, with a matching phase ----
  let items: string[] = [];
  if (backlog) {
    items = existsSync(backlog) ? readdirSync(backlog).filter((f) => /^skill-.*\.yaml$/.test(f)).map((f) => f.replace(/\.yaml$/, '')) : [];
    const listed = new Set(trace.requirements.flatMap((r: Doc) => r.backlog ?? []) as string[]);
    for (const b of items.filter((b) => !listed.has(b)).sort()) problems.push(`backlog ${b}: maps to no requirement`);
    for (const b of [...listed].filter((b) => !items.includes(b)).sort()) problems.push(`backlog ${b}: listed but no such file`);
    for (const r of trace.requirements) {
      const phases = new Set<string>();
      for (const b of r.backlog ?? []) {
        const f = join(backlog, `${b}.yaml`);
        if (existsSync(f)) for (const m of String(load(f)?.phase ?? '').matchAll(/\b(1|2|aws|later|plan)\b/g)) phases.add(m[1]);
      }
      if (phases.size && !phases.has(String(r.phase)) && !(phases.size === 1 && phases.has('plan'))) {
        problems.push(`${r.id}: phase ${r.phase} but its backlog items say [${[...phases].sort().join(', ')}]`);
      }
    }
  }

  // ---- query sets: each set equals what the queries' own labels say ----
  const derived: Record<string, (q: Doc) => boolean> = {
    'must-find': (q) => (q.must_find ?? []).length > 0,
    'no-match': (q) => (q.must_find ?? []).length === 0,
    'keyword-gate': (q) => q.keyword_route_expected === 'hit',
    'semantic-gap': (q) => q.keyword_route_expected === 'miss',
    'keyword-gate-any': (q) => q.any_word_route_expected === 'hit',
    'semantic-gap-any': (q) => q.any_word_route_expected === 'miss',
  };
  for (const [name, ids] of Object.entries(g.queries.sets ?? {}) as [string, string[]][]) {
    const test = derived[name];
    if (!test) { problems.push(`queries: set ${name} has no rule to check it against`); continue; }
    const want = queries.filter(test).map((q) => q.id);
    const missing = want.filter((id) => !ids.includes(id)), extra = ids.filter((id) => !want.includes(id));
    if (missing.length || extra.length) problems.push(`queries: set ${name} drifted:${missing.length ? ` missing ${missing.join(', ')}` : ''}${extra.length ? ` extra ${extra.join(', ')}` : ''}`);
  }

  // ---- hand-written diffs equal diff -u on the version bytes (hunk bodies) ----
  const diffsDir = join(qa, 'golden', 'diffs');
  for (const f of existsSync(diffsDir) ? readdirSync(diffsDir).filter((x) => x.endsWith('.diff')) : []) {
    const m = f.match(/^(\w+)-(\d+)-(\d+)\.diff$/);
    if (!m) { problems.push(`diff ${f}: name should be <history>-<from>-<to>.diff`); continue; }
    const [a, b] = [`${m[1]}.v${m[2]}`, `${m[1]}.v${m[3]}`];
    if (!versions.has(a) || !versions.has(b)) { problems.push(`diff ${f}: no versions ${a} and ${b}`); continue; }
    const real = hunkBodies(diffU(g.histories.versions[a], g.histories.versions[b]));
    const want = hunkBodies(readFileSync(join(diffsDir, f), 'utf8'));
    if (real.join('\n') !== want.join('\n')) problems.push(`diff ${f.replace(/\.diff$/, '')}: differs from diff -u (real ${real.length} lines, written ${want.length})`);
  }

  // ---- goldens cross-check (check_goldens.py): fingerprints (contract §4.3) and name lengths ----
  const fp = (v: string) => fingerprint(g.histories.versions[v] ?? {});
  const h1 = ['h1.v1', 'h1.v2', 'h1.v3', 'h1.v4'].filter((v) => versions.has(v));
  if (h1.length === 4 && new Set(h1.map(fp)).size !== 4) problems.push('goldens: the h1 versions are not all distinct');
  const same = [['h1.v1', 'release-note-draft'], ['prc.v1', 'pr-review-checklist']] as const;
  for (const [v, skill] of same) {
    const files = g.skills.valid?.[skill]?.files;
    if (versions.has(v) && files && fp(v) !== fingerprint(files)) problems.push(`goldens: ${v} differs from skills.valid.${skill} (fingerprint)`);
  }
  for (const group of ['valid', 'invalid']) {
    for (const [k, want] of [['name-64', 64], ['name-65', 65]] as const) {
      const md = String(g.skills[group]?.[k]?.files?.['SKILL.md'] ?? '');
      const m = ('\n' + md).match(/\nname: ([^\n]*)\n/);
      if (m && m[1].length !== want) problems.push(`goldens: ${k} has a ${m[1].length}-character name`);
    }
  }

  return {
    problems,
    counts: { backlog: items.length, requirements: trace.requirements.length, scenarios: scen.size, queries: qids.size, policy: (g.policy.cases ?? []).length },
  };
}

const bytes = (c: unknown) => (typeof c === 'string' ? c : String((c as Doc).text ?? ''));

function diffU(from: Doc, to: Doc): string {
  const t = mkdtempSync(join(tmpdir(), 'qa-diff-'));
  try {
    for (const [side, files] of [['a', from], ['b', to]] as const) {
      mkdirSync(join(t, side));
      for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(t, side, p)), { recursive: true }); writeFileSync(join(t, side, p), bytes(c)); }
    }
    return spawnSync('diff', ['-ruN', 'a', 'b'], { cwd: t, encoding: 'utf8' }).stdout;
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
}

/** The changed and context lines only: headers and hunk positions differ between `diff -N` and a hand-written diff. */
const hunkBodies = (text: string) => text.split('\n').filter((l) => l && !/^(--- |\+\+\+ |diff |@@)/.test(l));

/** Contract §4.3: one line per file, `<mode> <sha256> <NFC path>`, sorted by path, then sha256 of the listing. */
export function fingerprint(files: Doc): string {
  const rows = Object.entries(files).map(([p, c]) => {
    const path = p.normalize('NFC'), mode = c && typeof c === 'object' && c.mode ? String(c.mode) : '0644';
    return [path, `${mode} ${createHash('sha256').update(bytes(c)).digest('hex')} ${path}\n`] as const;
  }).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return 'sha256:' + createHash('sha256').update(rows.map(([, r]) => r).join('')).digest('hex');
}
