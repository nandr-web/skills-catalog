// `qa trace-check` (qa-plan §9; brief §3), a port of the QA plan's preview checker.
// It must pass on the real goldens, and fail with a clear message for each kind of break, shown on a broken copy.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { runnableTests, traceCheck } from '../src/trace-check.ts';
import { cleanup, scratch } from './machine.ts';

const QA = fileURLToPath(new URL('..', import.meta.url));
afterEach(cleanup);

/** A copy of the goldens and traceability, plus a backlog folder made from traceability's own backlog references. */
function copy(): { qa: string; backlog: string } {
  const root = scratch('qa-trace-');
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
    expect(r.counts.backlog).toBe(54);
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

  // Review P11.3, V2.2 (and the validator's round): the requirements page says "built" from the tests named for each
  // requirement item (items: in the trace file), so each name must be a test file in the repo with at least one test that
  // runs (not skipped, not expected to fail); not_yet is the words for what isn't built, and can only lower a status.
  it('fails when an item names a test file that doesn\'t exist, isn\'t a test file, or has no test that runs', () => {
    const c = copy();
    // A repo of its own, so a test file can be skip-only: one that runs, one whose tests are all skipped or expected to fail.
    const repo = scratch('qa-trace-repo-');
    mkdirSync(join(repo, 'core', 'test'), { recursive: true });
    writeFileSync(join(repo, 'core', 'test', 'runs.test.ts'), "it('runs', () => {});\n");
    writeFileSync(join(repo, 'core', 'test', 'skipped.test.ts'), "describe.skip('later', () => {\n  it('a', () => {});\n});\nit.fails('b', () => {});\n");
    edit(join(c.qa, 'traceability.yaml'), (d) => {
      d.items = {
        'skill-publish': { tests: ['core/test/no-such.test.ts', 'core/src/catalog.ts', '../outside.test.ts', 'core/test/skipped.test.ts', 'core/test/runs.test.ts'] },
        'skill-versions': { tests: 'core/test/runs.test.ts', not_yet: 3 },
        'skill-no-such-item': { tests: ['core/test/runs.test.ts'] },
        'skill-discover': { tests: ['core/test/runs.test.ts'], color: 'x' },
      };
    });
    const p = traceCheck({ qa: c.qa, backlog: c.backlog, repo }).problems;
    expect(p).toEqual(expect.arrayContaining([
      "item skill-publish: test 'core/test/no-such.test.ts' doesn't exist",
      "item skill-publish: test 'core/src/catalog.ts' isn't a test file (<package>/test/….test.ts)",
      "item skill-publish: test '../outside.test.ts' isn't a test file (<package>/test/….test.ts)",
      "item skill-publish: test 'core/test/skipped.test.ts' has no test that runs (each is skipped or expected to fail)",
      'item skill-versions: tests should be a list of test files',
      'item skill-versions: not_yet should be words',
      'item skill-no-such-item: no such requirement item',
      'item skill-discover: unknown key color (tests and not_yet only)',
    ]));
    expect(p.filter((x) => x.includes('runs.test.ts'))).toEqual([]);
  });

  it('counts the tests that run: plain, each, only, sequential and conditional calls and shared suites; never skipped, todo or expected-fail ones, nor those in a skipped block or a comment', () => {
    expect(runnableTests("it('a', () => {});\ntest.each([1])('b %s', () => {});\nit.only('c', () => {});\nit.sequential('d', () => {});\nit.skipIf(x)('e', () => {});")).toBe(5);
    expect(runnableTests("it.skip('a', () => {});\nit.todo('b');\nit.fails('c', () => {});\n// it('e')\n * it('f')")).toBe(0);
    expect(runnableTests("describe.skip('later', () => {\n  it('a', () => {});\n});\nit('b', () => {});")).toBe(1);
    expect(runnableTests("describe('x', () => {\n  it('a', () => {});\n});\nstorageSuite(hosted);\nfor (const a of ADAPTERS) discoverySuite(a);\nimport { catalogSuite } from './x.ts';")).toBe(3);
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

  // Review P3.2, P11.3: an agent check counts as automated only if the runner runs its scenario.
  it('fails when an agent check is marked auto but the runner skips its scenario, saying why', () => {
    const c = copy();
    edit(join(c.qa, 'traceability.yaml'), (d) => {
      const r = d.requirements.find((x: any) => x.id === 'retrieve');
      const a4 = r.checks.find((x: any) => x.golden === 'agent.A4');
      a4.auto = true;
      delete a4.automate_by;
    });
    const problems = traceCheck(c).problems;
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^retrieve: check "A4 .*" is marked auto, but the runner skips A4 \(starting catalog histories\.h1@v4 needs/);
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
