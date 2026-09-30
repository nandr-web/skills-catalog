// person-eval's scorer (qa/person-eval/measure.ts), tests first: counts with their 95% interval, an answer and its cost
// read from a stream-json trace with the product's own trace parser, old runs' plain answers still read, the word
// ceilings, and one history row per answer.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerOf, CEILINGS, historyRows, rate, readAnswer, scoreDir } from '../person-eval/measure.ts';
import { cleanup, scratch } from './machine.ts';

afterEach(() => cleanup());

const trace = (text: string, cost: number) => [
  JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet', permissionMode: 'default', tools: [] }),
  JSON.stringify({ type: 'assistant', session_id: 's1', message: { content: [{ type: 'text', text }] } }),
  JSON.stringify({ type: 'result', session_id: 's1', is_error: false, result: text, duration_ms: 900, total_cost_usd: cost, num_turns: 2 }),
].join('\n');

const LOG = [
  '14:00:01  ana   publish_skill_to_catalog     published                                                  release-note-draft v1',
  '14:00:05  bob   search_shared_skills         1 of 1 match                                               release-note-draft',
  '14:00:09  bob   install_shared_skill         installed                                                  release-note-draft v1',
].join('\n');

/** A run folder: try 1 answered as traces (with ana's setup traces), try 2 as plain answers (an old run), try 3 whose
 *  setup failed. */
function run(): string {
  const d = scratch('person-eval-');
  writeFileSync(join(d, '1-activity.log'), LOG);
  writeFileSync(join(d, '1-search.jsonl'), trace('| Skill | Version |\n| --- | --- |\n| **release-note-draft** | v1 |', 0.02));
  writeFileSync(join(d, '1-list.jsonl'), trace('You have release-note-draft installed.', 0.01));
  writeFileSync(join(d, '1-setup-publish-1.jsonl'), trace('Published.', 0.004));
  writeFileSync(join(d, '2-activity.log'), LOG);
  writeFileSync(join(d, '2-search.md'), 'Found release-note-draft ✓ in the catalog.\n');
  writeFileSync(join(d, '3-activity.log'), '14:00:05  bob   search_shared_skills         nothing matches  -');
  writeFileSync(join(d, '3-search.md'), 'Nothing.\n');
  writeFileSync(join(d, 'meta.json'), JSON.stringify({ sha: 'abc1234', model: 'sonnet', tries: 3, started: '2026-09-30T15:00:00Z' }));
  return d;
}

describe('person-eval scoring', () => {
  it('a yes/no measure is k/n with its Wilson 95% interval', () => {
    expect(rate([1, 1, 0, 0])).toBe('2/4 50% [15–85]');
    expect(rate([0, 0, 0])).toBe('0/3 0% [0–56]');
    expect(rate([])).toBe('-');
  });

  it("an answer and its cost come from the trace, read by the product's own trace parser", () => {
    expect(answerOf(trace('Hello **there**', 0.0123))).toEqual({ text: 'Hello **there**', costUsd: 0.0123 });
    expect(answerOf('not json at all')).toEqual({ text: '', costUsd: 0 });
  });

  it("a checkout whose try-claude.sh doesn't save traces yet: its plain answer is read as is, with no cost", () => {
    expect(readAnswer('Found release-note-draft.\n')).toEqual({ text: 'Found release-note-draft.\n', costUsd: undefined });
    expect(readAnswer(trace('Hi', 0.5))).toEqual({ text: 'Hi', costUsd: 0.5 });
  });

  it("reads traces and old plain answers, leaves out a try whose setup failed, and adds up the run's cost", () => {
    const d = run();
    const s = scoreDir(d);
    expect(s.rows.map((r) => `${r.t}-${r.scenario}`)).toEqual(['1-list', '1-search', '2-search']);
    const search1 = s.rows.find((r) => r.t === '1' && r.scenario === 'search')!;
    expect(search1).toMatchObject({ table: 1, right: 1, costUsd: 0.02 });
    expect(s.rows.find((r) => r.t === '2')).toMatchObject({ marks: 1, costUsd: undefined });
    // every trace in the folder counts, ana's setup too, and the try left out: it was paid for
    expect(s.costUsd).toBeCloseTo(0.034, 6);
    expect(s.meta).toMatchObject({ sha: 'abc1234', model: 'sonnet' });
  });

  it('an answer over its ask\'s word ceiling is counted', () => {
    const d = run();
    writeFileSync(join(d, '2-search.md'), 'Found release-note-draft. ' + 'word '.repeat(CEILINGS['search']!));
    const s = scoreDir(d);
    expect(s.rows.find((r) => r.t === '2')!.over).toBe(1);
    expect(s.rows.find((r) => r.t === '1' && r.scenario === 'search')!.over).toBe(0);
  });

  it('a history row per answer: which run, which checkout and model, and every measure', () => {
    const d = run();
    const rows = historyRows(d, scoreDir(d), '2026-09-30T16:00:00Z');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ scored: '2026-09-30T16:00:00Z', sha: 'abc1234', model: 'sonnet', try: '1', ask: 'list', right: 1 });
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining(['run', 'started', 'cost_usd', 'table', 'marks', 'box', 'words', 'over', 'internal', 'doubts']));
  });
});
