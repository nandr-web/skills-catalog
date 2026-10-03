// The docs that say what's built stay true (review V2.2, P11.3, P13.4, V5.2, V2.6): the requirements page matches the
// inputs it was generated from, the decision log's tallies are its rows' own, and the owner's words hold on these pages.
// Each rule passes on the real pages and fails, saying what to do, on a broken copy.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DECISIONS_PAGE, REQUIREMENTS_PAGE, decisionProblems, decisionRows, inputsHash, pageStamp, requirementInputs,
  requirementsPageProblems, wordProblems,
} from '../src/docs-truth.ts';
import { REPO } from '../src/trace-check.ts';
import { cleanup, scratch } from './machine.ts';

afterEach(cleanup);

/** A copy of the requirements page and its inputs. */
function copy(): string {
  const root = scratch('qa-docs-');
  cpSync(join(REPO, 'requirements'), join(root, 'requirements'), { recursive: true });
  mkdirSync(join(root, 'qa'));
  mkdirSync(join(root, 'docs'));
  cpSync(join(REPO, 'qa', 'traceability.yaml'), join(root, 'qa', 'traceability.yaml'));
  cpSync(join(REPO, REQUIREMENTS_PAGE), join(root, REQUIREMENTS_PAGE));
  return root;
}

describe('the requirements page (docs/requirements.md)', () => {
  it('was generated from the requirement list and the traceability file as they are now', () => {
    expect(requirementsPageProblems()).toEqual([]);
  });

  it('hashes every requirement file by name, then the traceability file', () => {
    const inputs = requirementInputs();
    expect(inputs.at(-1)).toBe('qa/traceability.yaml');
    expect(inputs.slice(0, -1)).toEqual([...inputs.slice(0, -1)].sort());
    expect(inputs.length).toBeGreaterThan(40);
    expect(inputsHash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is out of date when a requirement or the traceability file changes, and says how to regenerate it', () => {
    for (const changed of ['requirements/skill-publish.yaml', 'qa/traceability.yaml']) {
      const root = copy();
      expect(requirementsPageProblems(root)).toEqual([]);
      writeFileSync(join(root, changed), readFileSync(join(root, changed), 'utf8') + '\n');
      expect(requirementsPageProblems(root)).toEqual([expect.stringMatching(/^docs\/requirements\.md is out of date: .* Regenerate it with the requirement exporter \(md mode\)$/)]);
    }
  });

  it('is out of date when a requirement is added or removed', () => {
    const root = copy();
    cpSync(join(root, 'requirements', 'skill-publish.yaml'), join(root, 'requirements', 'skill-zz-new.yaml'));
    expect(requirementsPageProblems(root)).toHaveLength(1);
  });

  it('without its stamp, it says so', () => {
    const root = copy();
    const page = join(root, REQUIREMENTS_PAGE);
    writeFileSync(page, readFileSync(page, 'utf8').replace(/inputs sha256:[0-9a-f]{16}/, 'inputs unknown'));
    expect(requirementsPageProblems(root)).toEqual([expect.stringMatching(/has no inputs stamp/)]);
    expect(pageStamp('<!-- generated; inputs sha256:0123456789abcdef -->')).toBe('0123456789abcdef');
  });
});

describe('the decision log (docs/decisions.md)', () => {
  const real = readFileSync(join(REPO, DECISIONS_PAGE), 'utf8');

  it('numbers D1-D3 from the PRD and B1 onward in order, and its tallies are its rows\' own', () => {
    expect(decisionProblems(real)).toEqual([]);
    const rows = decisionRows(real);
    expect(rows.slice(0, 3).map((r) => r.by)).toEqual(['The PRD', 'The PRD', 'The PRD']);
    expect(rows.filter((r) => r.by === 'The owner').length).toBeGreaterThan(10);
  });

  it('fails when a row is added without the tallies, or the numbering skips', () => {
    const owner = real.split('\n').find((l) => l.startsWith('| B1 |'))!;
    const extra = real.replace(owner, `${owner}\n${owner.replace('| B1 |', '| B99 |')}`);
    const p = decisionProblems(extra);
    expect(p).toEqual(expect.arrayContaining([
      expect.stringMatching(/^decision 2 is numbered B99/),
      expect.stringMatching(/^the "At a glance" line says .*; the rows give/),
      expect.stringMatching(/^the tally table says The owner: /),
    ]));
  });

  it('fails when a row marked built changes to not built without the tally', () => {
    const row = real.split('\n').find((l) => l.startsWith('| B1 |'))!;
    expect(row.endsWith('| Yes |')).toBe(true);
    const p = decisionProblems(real.replace(row, row.replace(/\| Yes \|$/, '| Not built yet |')));
    expect(p).toEqual([expect.stringMatching(/^the tally table says The owner: \d+ decisions, \d+ not built yet; the rows give/)]);
  });

  it('fails on a "Decided by" it doesn\'t know', () => {
    const row = real.split('\n').find((l) => l.startsWith('| B22 |'))!;
    expect(decisionProblems(real.replace(row, row.replace('| The team |', '| The architects |')))).toEqual(
      expect.arrayContaining(['B22: "Decided by" is "The architects", none of The PRD, The owner, The team, Defaults awaiting the owner']));
  });
});

describe('the owner\'s words on these pages', () => {
  it('no "registry" beside the catalog; no "AI assistant" or "your machine" as an actor', () => {
    expect(wordProblems()).toEqual([]);
  });

  it('names the page, the line and the word; the PRD\'s mirrored rows keep their words', () => {
    const root = scratch('qa-words-');
    for (const d of ['docs', 'qa']) mkdirSync(join(root, d));
    for (const p of ['docs/architecture.md', 'docs/decisions.md', 'docs/agent-experience.md', 'docs/requirements.md', 'docs/contract.md', 'docs/api.md', 'qa/qa-plan.md']) {
      writeFileSync(join(root, p), 'fine\n');
    }
    writeFileSync(join(root, 'docs/architecture.md'), 'ok\nthe registry of skills\nruns on your machine\n');
    writeFileSync(join(root, 'docs/requirements.md'), 'Through an AI assistant (the PRD\'s words)\n');
    writeFileSync(join(root, 'docs/decisions.md'), '| D1 | Access is through an AI assistant | the PRD\'s row, as it is |\n| B1 | an AI assistant decides |\n');
    writeFileSync(join(root, 'docs/contract.md'), 'an inert file (review P3.1: an image)\nsee §5.3 and version 1.2\n');
    expect(wordProblems(root)).toEqual([
      'docs/architecture.md:2: "registry" (the owner calls the list of operations "the API" and the shared skills "the catalog")',
      'docs/architecture.md:3: "your machine" (the actors are the Developer and the Assistant)',
      'docs/decisions.md:2: "AI assistant" (the actors are the Developer and the Assistant)',
      'docs/contract.md:1: "P3.1" (a review finding\'s id is for the team, not the reader)',
    ]);
  });
});
