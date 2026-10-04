// The docs that say what's built stay true (review V2.2, P11.3, P13.4, V5.2, V2.6): the requirements page matches the
// inputs it was generated from, and the owner's words hold on these pages.
// Each rule passes on the real pages and fails, saying what to do, on a broken copy.
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  REQUIREMENTS_PAGE, inputsHash, pageStamp, requirementInputs,
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

describe('the owner\'s words on these pages', () => {
  it('no "registry" beside the catalog; no "AI assistant" or "your machine" as an actor', () => {
    expect(wordProblems()).toEqual([]);
  });

  it('names the page, the line and the word', () => {
    const root = scratch('qa-words-');
    for (const d of ['docs', 'qa']) mkdirSync(join(root, d));
    for (const p of ['docs/architecture.md', 'docs/decisions.yaml', 'docs/agent-experience.md', 'docs/requirements.md', 'docs/contract.md', 'docs/api.md', 'qa/qa-plan.md']) {
      writeFileSync(join(root, p), 'fine\n');
    }
    writeFileSync(join(root, 'docs/architecture.md'), 'ok\nthe registry of skills\nruns on your machine\n');
    writeFileSync(join(root, 'docs/requirements.md'), 'Through an AI assistant (the PRD\'s words)\n');
    writeFileSync(join(root, 'docs/decisions.yaml'), '- id: D1\n  text: Access is through an AI assistant (the PRD\'s words)\n  why: per review V5.6\n');
    writeFileSync(join(root, 'docs/contract.md'), 'an inert file (review P3.1: an image)\nsee §5.3 and version 1.2\n');
    expect(wordProblems(root)).toEqual([
      'docs/architecture.md:2: "registry" (the owner calls the list of operations "the API" and the shared skills "the catalog")',
      'docs/architecture.md:3: "your machine" (the actors are the Developer and the Assistant)',
      'docs/decisions.yaml:3: "V5.6" (a review finding\'s id is for the team, not the reader)',
      'docs/contract.md:1: "P3.1" (a review finding\'s id is for the team, not the reader)',
    ]);
  });
});
