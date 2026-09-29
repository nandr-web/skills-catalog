// `qa trace-check` (qa-plan §9; brief §3), a port of the QA plan's preview checker.
// It must pass on the real goldens, and fail with a clear message for each kind of break, shown on a broken copy.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { traceCheck } from '../src/trace-check.ts';

const QA = fileURLToPath(new URL('..', import.meta.url));
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A copy of the goldens and traceability, plus a backlog folder made from traceability's own backlog references. */
function copy(): { qa: string; backlog: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'qa-trace-')));
  made.push(root);
  const qa = join(root, 'qa'), backlog = join(root, 'backlog');
  cpSync(join(QA, 'golden'), join(qa, 'golden'), { recursive: true });
  cpSync(join(QA, 'traceability.yaml'), join(qa, 'traceability.yaml'));
  mkdirSync(backlog);
  const t = parse(readFileSync(join(qa, 'traceability.yaml'), 'utf8'));
  const phases: Record<string, Set<string>> = {};
  for (const r of t.requirements) for (const b of r.backlog ?? []) (phases[b] ??= new Set()).add(String(r.phase));
  for (const [b, p] of Object.entries(phases)) writeFileSync(join(backlog, `${b}.yaml`), stringify({ phase: [...p].join(', ') }));
  return { qa, backlog };
}
const edit = (file: string, f: (d: any) => void) => { const d = parse(readFileSync(file, 'utf8')); f(d); writeFileSync(file, stringify(d)); };

describe('qa trace-check', () => {
  it('passes on the real goldens and the exported requirement list (requirements/, the default)', () => {
    const r = traceCheck({ qa: QA });
    expect(r.problems).toEqual([]);
    expect(r.counts.backlog).toBe(40);
  });

  it('a check with a key outside layer, name, golden, auto and automate_by is a problem (a comma in an unquoted name makes one)', () => {
    const c = copy();
    const file = join(c.qa, 'traceability.yaml');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('    checks:\n');
    writeFileSync(file, text.replace('    checks:\n', '    checks:\n      - {layer: unit, name: a, b, auto: true}\n'));
    const first = parse(text).requirements[0].id;
    expect(traceCheck({ qa: c.qa, backlog: c.backlog }).problems).toEqual([`${first}: check "a" has the key b, outside layer, name, golden, auto and automate_by (quote a name that holds a comma)`]);
  });

  it('passes on a copy (the backlog made from traceability\'s own references)', () => {
    const c = copy();
    const r = traceCheck({ qa: c.qa, backlog: c.backlog });
    expect(r.problems).toEqual([]);
    const golden = (f: string) => parse(readFileSync(join(QA, 'golden', f), 'utf8'));
    expect(r.counts).toMatchObject({ scenarios: golden('agent-scenarios.yaml').scenarios.length, queries: golden('queries.yaml').queries.length });
  });

  it('fails when a requirement has no automated check, or a manual one says nothing about automating it', () => {
    const c = copy();
    edit(join(c.qa, 'traceability.yaml'), (d) => { d.requirements[0].checks = [{ layer: 'unit', name: 'by hand', auto: false }]; });
    expect(traceCheck({ qa: c.qa, backlog: c.backlog }).problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^publish: no automated check/), expect.stringMatching(/^publish: manual check without automate_by/),
    ]));
  });

  it('fails when a golden, catalog, query or fixture reference doesn\'t resolve', () => {
    const c = copy();
    edit(join(c.qa, 'traceability.yaml'), (d) => { d.requirements[0].checks[0].golden = 'skills.valid.no-such-skill'; });
    edit(join(c.qa, 'golden', 'agent-scenarios.yaml'), (d) => { d.scenarios[0].query = 'queries.q99'; d.scenarios[1].catalog = 'histories.h9@v1'; });
    const p = traceCheck({ qa: c.qa, backlog: c.backlog }).problems;
    expect(p).toEqual(expect.arrayContaining([
      "publish: golden 'skills.valid.no-such-skill' does not resolve",
      "scenario A1: query 'queries.q99' does not resolve",
      "scenario A2: catalog 'histories.h9@v1' does not resolve",
    ]));
  });

  it('fails when a scenario names an unknown requirement', () => {
    const c = copy();
    edit(join(c.qa, 'golden', 'agent-scenarios.yaml'), (d) => { d.scenarios[0].requirement = ['teleport']; });
    expect(traceCheck({ qa: c.qa, backlog: c.backlog }).problems).toContain("scenario A1: requirement 'teleport' not in traceability");
  });

  it('fails when a backlog item maps to no requirement, a listed one is missing, or the phases disagree', () => {
    const c = copy();
    writeFileSync(join(c.backlog, 'skill-orphan.yaml'), stringify({ phase: 1 }));
    writeFileSync(join(c.backlog, 'skill-publish.yaml'), stringify({ phase: 'aws' }));
    const p = traceCheck({ qa: c.qa, backlog: c.backlog }).problems;
    expect(p).toContain('backlog skill-orphan: maps to no requirement');
    expect(p.some((x) => /^publish: phase 1 but its backlog items say \[aws\]/.test(x))).toBe(true);
  });

  it('fails when the query sets drift from the queries\' own labels', () => {
    const c = copy();
    edit(join(c.qa, 'golden', 'queries.yaml'), (d) => { d.sets['no-match'] = d.sets['no-match'].slice(1); });
    expect(traceCheck({ qa: c.qa, backlog: c.backlog }).problems).toContain('queries: set no-match drifted: missing q28');
  });

  it('fails when a history version stops matching its skill fixture, or the h1 versions stop being distinct', () => {
    const c = copy();
    edit(join(c.qa, 'golden', 'histories.yaml'), (d) => { d.versions['h1.v1']['SKILL.md'] += '\n'; d.versions['h1.v4'] = d.versions['h1.v3']; });
    expect(traceCheck({ qa: c.qa, backlog: c.backlog }).problems).toEqual(expect.arrayContaining([
      'goldens: h1.v1 differs from skills.valid.release-note-draft (fingerprint)', 'goldens: the h1 versions are not all distinct',
    ]));
  });

  it('fails when a hand-written diff differs from diff -u on the version bytes', () => {
    const c = copy();
    const f = join(c.qa, 'golden', 'diffs', 'h1-1-2.diff');
    writeFileSync(f, readFileSync(f, 'utf8').replace(/^\+(?!\+\+ )(.*)$/m, '+$1 (edited by hand)'));
    expect(traceCheck({ qa: c.qa, backlog: c.backlog }).problems.some((x) => x.startsWith('diff h1-1-2: differs from diff -u'))).toBe(true);
  });
});
