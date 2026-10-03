// The system map check (docs/map/map.yaml; qa/src/map): the map agrees with the code, the files on disk are a fresh
// build, every picture reads on a phone, and each kind of drift is caught (one planted case per rule).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildMap, ROOT, SOURCE } from '../src/map/build.ts';
import { readFacts, type Facts } from '../src/map/facts.ts';
import { checkMap, type MapSource, type Rule } from '../src/map/map.ts';
import { MIN_PHONE_PX, PHONE_COLUMN, phoneProblems, smallestFont, viewBoxWidth } from '../src/map/phone.ts';

const source = (): MapSource => parse(readFileSync(join(ROOT, SOURCE), 'utf8'));
let facts: Facts;
beforeAll(() => { facts = readFacts(ROOT); });
const exists = (p: string) => existsSync(join(ROOT, p));
const rules = (m: MapSource) => checkMap(m, facts, exists).map((p) => p.rule);
const part = (m: MapSource, id: string) => m.parts.find((p) => p.id === id)!;
const flow = (m: MapSource, id: string) => m.flows.find((f) => f.id === id)!;

describe('the system map', () => {
  it('agrees with the code: every tool, command, operation, requirement, file and screen', () => {
    expect(checkMap(source(), facts, exists)).toEqual([]);
  });

  it('is on disk exactly as a fresh build makes it (run npm run map in qa/ after changing the map or the code)', async () => {
    const built = await buildMap();
    expect(built.problems).toEqual([]);
    expect([...built.files.keys()].sort()).toEqual(['docs/map/index.html', 'docs/pictures/map-aws.svg', 'docs/pictures/map-held-update.svg', 'docs/pictures/map-local.svg']);
    for (const [path, text] of built.files) expect(readFileSync(join(ROOT, path), 'utf8'), `${path} is stale: run npm run map in qa/`).toBe(text);
  }, 60_000);

  it('reads the facts from the code, not from a list kept by hand', () => {
    expect(facts.tools).toContain('publish_skill_to_catalog');
    expect(facts.tools).not.toContain('publish_version'); // an operation the MCP server doesn't serve
    expect(facts.commands).toContain('teardown');
    expect(facts.operations).toContain('sign_in_with_github');
    expect(facts.requirements.get('publish')).toMatchObject({ text: expect.stringContaining('publishes a skill') });
    expect(readFileSync(join(ROOT, 'qa/traceability.yaml'), 'utf8').split('\n')[facts.requirements.get('publish')!.line - 1]).toBe('  - id: publish');
    expect(facts.sources).toContain('client/src/cli/setup.ts');
  });
});

describe('the map check catches each kind of drift', () => {
  const caught = (rule: Rule, plant: (m: MapSource) => void) => {
    const m = structuredClone(source());
    plant(m);
    expect(rules(m)).toContain(rule);
  };
  it('a part\'s code or tests that match no file', () => caught('glob-matches-nothing', (m) => { part(m, 'catalog').tests = ['core/test/not-there/**']; }));
  it('a source file in no part', () => caught('file-in-no-part', (m) => {
    for (const id of ['sc1', 'sc2']) part(m, id).code = part(m, id).code!.filter((g) => g !== 'core/src/ports.ts');
  }));
  it('a planned part that has code', () => caught('planned-part-has-code', (m) => { part(m, 'catalog').status = 'proposed'; }));
  it('a step naming a tool that isn\'t served', () => caught('unknown-tool', (m) => { flow(m, 'discover').steps[1]!.tools = ['search_everything']; }));
  it('a step naming a command the CLI hasn\'t', () => caught('unknown-command', (m) => { flow(m, 'setup').steps[0]!.commands = ['install-everything']; }));
  it('a step naming an operation the API hasn\'t', () => caught('unknown-operation', (m) => { flow(m, 'retrieve').steps[2]!.operations = ['fetch_all']; }));
  it('a check naming a requirement that doesn\'t exist', () => caught('unknown-requirement', (m) => { flow(m, 'publish').checks!.push('publish-everything'); }));
  it('a served tool in no step and not left out', () => caught('tool-in-no-step', (m) => { delete m.left_out!.tools!['set_skill_update_policy']; }));
  it('a served command in no step and not left out', () => caught('command-in-no-step', (m) => { delete m.left_out!.commands!['stats']; }));
  it('an operation in no step and not left out', () => caught('operation-in-no-step', (m) => { delete m.left_out!.operations!['list_tokens']; }));
  it('a step\'s operations for a view the map hasn\'t', () => caught('unknown-view', (m) => {
    flow(m, 'discover').steps[2]!.operations = { mars: ['search_shared_skills'] };
  }));
  it('something left out with no reason', () => caught('left-out-without-why', (m) => { m.left_out!.commands!['stats'] = ' '; }));
  it('a screen that isn\'t there', () => caught('missing-screen', (m) => { flow(m, 'publish').screens!.push('docs/pictures/claude-code/nothing.png'); }));
  it.each([['registry'], ['your'], ['AI assistant'], ['core catalog'], ['local store']])('the banned word "%s"', (word) =>
    caught('banned-word', (m) => { flow(m, 'held-update').steps[0]!.label = `Developer 2 checks the ${word}`; }));
  it('a picture whose labels would shrink under 9px on a phone', () => {
    const wide = readFileSync(join(ROOT, 'docs/pictures/map-local.svg'), 'utf8').replace(/viewBox="0 0 \d+/, 'viewBox="0 0 900');
    expect(phoneProblems('map-local.svg', wide).map((p) => p.rule)).toEqual(['unreadable-on-phone']);
  });
  it('a stale page or picture on disk', async () => {
    const m = source();
    m.title = 'Skills Catalog, renamed';
    const built = await buildMap(ROOT, m);
    expect(built.files.get('docs/map/index.html')).not.toBe(readFileSync(join(ROOT, 'docs/map/index.html'), 'utf8'));
  }, 60_000);
});

describe('neutral names', () => {
  // The drawing tool's name, built from parts so this file doesn't carry it either.
  const TOOL = new RegExp(['sten', 'cil'].join(''), 'i');
  it('the generated files, the renderer and every picture use the d- classes and never name the drawing tool', () => {
    const pictures = readdirSync(join(ROOT, 'docs/pictures')).filter((f) => f.endsWith('.svg')).map((f) => `docs/pictures/${f}`);
    for (const path of ['docs/map/index.html', 'qa/src/map/renderer.js', ...pictures]) {
      const text = readFileSync(join(ROOT, path), 'utf8');
      expect(text, path).not.toMatch(TOOL);
      expect(text, path).not.toMatch(/\bst-[a-z]/);
    }
  });
});

describe('pictures on a phone', () => {
  it('every map picture keeps its smallest label at 9px or more in a phone\'s column', () => {
    for (const name of ['local', 'aws', 'held-update']) {
      const svg = readFileSync(join(ROOT, `docs/pictures/map-${name}.svg`), 'utf8');
      const px = smallestFont(svg) * Math.min(1, PHONE_COLUMN / viewBoxWidth(svg));
      expect(px, name).toBeGreaterThanOrEqual(MIN_PHONE_PX);
    }
  });
  it('reads the smallest size from the classes a picture uses, not from every rule in its stylesheet', () => {
    const svg = '<svg viewBox="0 0 300 100"><style>.big { font-size: 14px } .tiny { font-size: 6px } .st { font: 600 12px mono }</style><text class="st big">x</text></svg>';
    expect(smallestFont(svg)).toBe(12);
  });
});
