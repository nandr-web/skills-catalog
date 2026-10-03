// The system map's pages (map.yaml `pages:`, qa/src/map/pages.ts, site.ts) and the decision log as data
// (docs/decisions.yaml, decisions.ts): each check catches its kind of drift (one planted case per rule), the lines on
// a page are the code's, and the pages show what the owner asked for: a page per part, its insides, its decisions.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { mapIds, ROOT, SOURCE } from '../src/map/build.ts';
import { checkDecisions, decisionCell, decisionsAbout, decisionsMarkdown, DECISIONS_PAGE, DECISIONS_SOURCE, type DecisionLog } from '../src/map/decisions.ts';
import { readFacts, type Facts } from '../src/map/facts.ts';
import { checkMap, type MapSource, type Rule } from '../src/map/map.ts';
import { foundationUsers, packageLines, pageViews, readLines, type Page } from '../src/map/pages.ts';

const source = (): MapSource => parse(readFileSync(join(ROOT, SOURCE), 'utf8'));
const decisions = (): DecisionLog => parse(readFileSync(join(ROOT, DECISIONS_SOURCE), 'utf8'));
let facts: Facts;
beforeAll(() => { facts = readFacts(ROOT); });
const exists = (p: string) => existsSync(join(ROOT, p));
const page = (m: MapSource, id: string) => m.pages!.find((p) => p.id === id)!;
const box = (pg: Page, id: string) => pg.boxes.find((b) => b.id === id)!;
const html = (name: string) => readFileSync(join(ROOT, 'docs/map', name), 'utf8');

describe('a page per part: its boxes and the lines read between them', () => {
  it('reads the lines inside skills-catalog from the imports: the faces run the operations', () => {
    const m = source();
    const lines = readLines(page(m, 'skills-catalog'), 'local', facts);
    const has = (a: string, b: string) => lines.some((l) => (l.from === a && l.to === b) || (l.both && l.from === b && l.to === a));
    expect(has('mcp', 'ops')).toBe(true);
    expect(has('cli', 'ops')).toBe(true);
    expect(has('ops', 'installer')).toBe(true);
    // A foundation box draws no lines; it says who uses it instead.
    expect(lines.some((l) => [l.from, l.to].includes('api'))).toBe(false);
    expect(foundationUsers(page(m, 'skills-catalog'), box(page(m, 'skills-catalog'), 'api'), 'local', facts)).toEqual(expect.arrayContaining(['mcp', 'cli', 'ops']));
  });
  it('reads the lines in AWS from the stack, with what each may do', () => {
    const lines = readLines(page(source(), 'catalog-aws'), 'aws', facts);
    expect(lines).toContainEqual({ from: 'api-function', to: 'versions-table', both: false, words: 'reads, writes' });
    expect(lines).toContainEqual({ from: 'indexer', to: 'events', both: false, words: 'receives' });
    expect(lines).toContainEqual({ from: 'sweep', to: 'versions-table', both: false, words: 'reads' });
    // A policy naming who may use a bucket isn't a use: CloudFront reads the page files, not the other way round.
    expect(lines).toContainEqual({ from: 'edge', to: 'page-files', both: false });
  });
  it('draws a page in the views its parts are in', () => {
    const m = source();
    expect(pageViews(m, page(m, 'skills-catalog'))).toEqual(['local', 'aws']);
    expect(pageViews(m, page(m, 'catalog'))).toEqual(['local']);
    expect(pageViews(m, page(m, 'catalog-aws'))).toEqual(['aws']);
  });
  it('reads which package uses which', () => {
    const lines = packageLines(facts, ['core', 'client', 'hosted', 'infra']);
    expect(lines).toEqual(expect.arrayContaining([{ from: 'client', to: 'core', both: false }, { from: 'hosted', to: 'core', both: false }]));
    expect(lines.some((l) => l.from === 'core')).toBe(false); // core uses no other package
  });
});

describe('the page checks catch each kind of drift', () => {
  const caught = (rule: Rule, plant: (m: MapSource) => void) => {
    const m = structuredClone(source());
    plant(m);
    const found = checkMap(m, facts, exists).map((p) => p.rule);
    expect(found, `planted ${rule}`).toContain(rule);
  };
  it('a page for a part that isn\'t on the map', () => caught('unknown-part', (m) => { page(m, 'catalog').parts = ['warehouse']; }));
  it('a box id used twice on the map', () => caught('duplicate-id', (m) => { box(page(m, 'catalog'), 'outbox').id = 'files-bucket'; }));
  it('a planned box that names no requirement', () => caught('planned-needs-nothing', (m) => { delete box(page(m, 'skills-catalog'), 'agent-reviewers').needs; }));
  it('a planned part that names no requirement', () => caught('planned-needs-nothing', (m) => { delete m.parts.find((p) => p.id === 'web')!.needs; }));
  it('a planned box that has code (so it\'s built)', () => caught('planned-part-has-code', (m) => { box(page(m, 'catalog'), 'outbox').status = 'proposed'; box(page(m, 'catalog'), 'outbox').needs = ['bundles']; }));
  it('a file of the part in no box', () => caught('file-in-no-box', (m) => { box(page(m, 'catalog'), 'outbox').code = []; box(page(m, 'catalog'), 'outbox').tests = []; }));
  it('a file in two boxes', () => caught('file-in-two-boxes', (m) => { box(page(m, 'catalog'), 'outbox').code!.push('core/src/local/blobs.ts'); }));
  it('a box naming code that isn\'t the part\'s', () => caught('box-file-outside-part', (m) => { box(page(m, 'catalog'), 'outbox').code!.push('hosted/src/events.ts'); }));
  it('an AWS resource in no box', () => caught('resource-in-no-box', (m) => { box(page(m, 'catalog-aws'), 'alarms').resources = []; }));
  it('an AWS resource in two boxes', () => caught('resource-in-two-boxes', (m) => { box(page(m, 'catalog-aws'), 'alarms').resources!.push('Sweep*'); }));
  it('a resource pattern that matches nothing in the stack', () => caught('glob-matches-nothing', (m) => { box(page(m, 'catalog-aws'), 'alarms').resources!.push('Warehouse*'); }));
  it('words on a line between two boxes that the code doesn\'t have', () => caught('line-not-in-code', (m) => {
    page(m, 'skills-catalog').lines!.push({ from: 'person', to: 'usage', label: 'counts' });
  }));
  it('a line to a part around that no import backs', () => caught('line-not-in-code', (m) => {
    page(m, 'skills-catalog').lines!.push({ from: 'usage', to: 'catalog', label: 'reads', only: ['local'] });
  }));
  it('a line to a part around that the map one level up doesn\'t link', () => caught('line-not-on-map', (m) => {
    page(m, 'catalog-aws').context!.push({ part: 'cc2', at: [2, 0] });
    page(m, 'catalog-aws').lines!.push({ from: 'cc2', to: 'edge', label: 'asks' });
  }));
  it('a page with more boxes than read at a glance', () => caught('too-dense', (m) => {
    const pg = page(m, 'catalog');
    for (let i = 0; i < 8; i++) pg.boxes.push({ id: `extra-${i}`, label: `extra ${i}`, at: [3 + (i % 3), i], status: 'proposed', needs: ['bundles'] });
  }));
  it('a package with no box in the Code view', () => caught('package-not-shown', (m) => { m.code!.packages = m.code!.packages.filter((p) => p.id !== 'infra'); }));
});

describe('decisions as data', () => {
  it('builds docs/decisions.md from docs/decisions.yaml, byte for byte', () => {
    expect(decisionsMarkdown(decisions())).toBe(readFileSync(join(ROOT, DECISIONS_PAGE), 'utf8'));
  });
  it('agrees with the map: every part it names is there, every chosen option is one of its options', () => {
    expect(checkDecisions(decisions(), mapIds(source()))).toEqual([]);
  });
  it('writes a decision as the log does: its lead in bold, then what it was chosen over', () => {
    const b1 = decisions().decisions.find((d) => d.id === 'B1')!;
    expect(decisionCell(b1)).toBe('**What ships first:** everything runs locally by default; AWS is opt-in, off by default. Over: building the web UI and AWS hosting first');
  });
  it('finds the decisions about a box, through the aspect that was weighed for it', () => {
    const about = decisionsAbout(decisions(), 'versions-table');
    expect(about.map((x) => x.decision.id)).toEqual(['B13']);
    expect(about[0]!.aspects.map((a) => [a.title, a.chosen])).toEqual([['Skills store: versions + files', 'ddb']]);
  });
  const plant = (rule: Rule, change: (log: DecisionLog) => void) => {
    const log = structuredClone(decisions());
    change(log);
    expect(checkDecisions(log, mapIds(source())).map((p) => p.rule)).toContain(rule);
  };
  it('a decision naming a part that isn\'t on the map', () => plant('decision-unknown-part', (l) => { l.decisions[0]!.parts = ['warehouse']; }));
  it('an aspect naming a part that isn\'t on the map', () => plant('decision-unknown-part', (l) => { l.decisions.find((d) => d.id === 'B13')!.aspects![0]!.parts.push('warehouse'); }));
  it('a chosen option that is none of the options', () => plant('chosen-not-an-option', (l) => { l.decisions.find((d) => d.id === 'B13')!.aspects![0]!.chosen = 'mainframe'; }));
  it('a decision id used twice', () => plant('duplicate-id', (l) => { l.decisions[1]!.id = l.decisions[0]!.id; }));
  it('a decision in a group the log doesn\'t have', () => plant('unknown-decision', (l) => { l.decisions[0]!.group = 'committee'; }));
});

describe('the pages show what was asked for', () => {
  it('the structure page: the running parts in each place, built and with what\'s planned, and the code', () => {
    const s = html('structure.html');
    for (const v of ['local', 'aws']) for (const p of ['0', '1']) expect(s).toContain(`data-sv="running" data-view="${v}" data-planned="${p}"`);
    expect(s).toContain('data-sv="code"');
    expect(s).toMatch(/<button type="button" class="switch" data-planned[^>]*aria-label="Show what's planned">/);
    // A part with a page links to it; the planned web page is only in the drawing with what's planned.
    expect(s).toMatch(/<a class="d-map-part d-map-part--opens" data-part="sc1" href="skills-catalog.html"/);
    expect(s).toMatch(/<a class="d-map-part d-map-part--opens" data-part="catalog" href="catalog-aws.html"/);
    expect(s.match(/data-part="web"/g)?.length).toBe(2); // in AWS and on one machine, with what's planned only
  });
  it('a part\'s page: its boxes, where it sits, its decisions, the steps through it, a way back', () => {
    const p = html('catalog-aws.html');
    expect(p).toContain('<a href="structure.html">Structure</a>');
    for (const b of ['edge', 'http-api', 'api-function', 'versions-table', 'files-bucket', 'events', 'indexer', 'sweep', 'alarms', 'page-files']) expect(p).toContain(`data-box="${b}"`);
    expect(p).toContain('Where it sits');
    expect(p).toContain('id="decision-B13"');
    expect(p).toMatch(/held update<\/strong><\/a>, step \d/);
  });
  it('clicking the database shows the options weighed, the one chosen, and what drove it', () => {
    const p = html('catalog-aws.html');
    const card = p.slice(p.indexOf('data-box="versions-table"'), p.indexOf('</article>', p.indexOf('data-box="versions-table"')));
    expect(card).toContain('<details class="aspect" open>');
    expect(card).toContain('<span class="pick">DynamoDB + S3</span>, chosen over Postgres + S3, Aurora DSQL + S3, SQLite + a folder');
    expect(card).toContain('Cost when idle');
  });
  it('no page shows a reader "undefined", "NaN" or "[object Object]"', () => {
    for (const name of ['index.html', 'structure.html', 'decisions.html', 'skills-catalog.html', 'catalog.html', 'catalog-aws.html']) {
      const shown = html(name).replace(/<script[\s\S]*?<\/script>/g, '');
      expect(shown, name).not.toMatch(/\bundefined\b|\bNaN\b|\[object Object\]/);
    }
  });
  it('the decisions page lists every decision, each with its own anchor', () => {
    const d = html('decisions.html');
    for (const x of decisions().decisions) expect(d).toContain(`id="decision-${x.id}"`);
  });
});
