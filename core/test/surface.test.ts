// Nothing unfilled reaches an agent: every word the surface can show renders with no ${op} or {field} left, in
// every variant; and the words that don't exist yet are listed, so each is wired the moment it lands.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';
import { OPERATIONS } from '../src/registry.ts';
import { WORD_GAPS, renderError, renderRead, renderSearch } from '../src/render.ts';
import { SURFACE_FILE, Surface } from '../src/surface.ts';
import { toCatalogError } from '../src/internal-error.ts';
import { CatalogError } from '../src/errors.ts';
import type { ReadItem } from '../src/catalog.ts';
import { discoveryCorpus } from './corpus.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { errorOf, openTest, request } from './helpers.ts';
import { sandbox } from './sandbox.ts';

const UNFILLED = /\$\{|\{[a-z_]+\}/;
const doc = parse(readFileSync(SURFACE_FILE, 'utf8'));
const VARIANTS = Object.keys(doc.variants);
const histories = loadGolden('histories.yaml');

function seeded() {
  const opened = openTest();
  for (const sk of discoveryCorpus()) opened.catalog.publish({ name: sk.name, files: sk.files }, 'ana');
  for (const v of ['h1.v1', 'h1.v2']) opened.catalog.publish(request('release-notes-kit', historyVersion(histories.versions[v]).map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.from(Buffer.from(f.bytes).toString().replace('name: release-note-draft', 'name: release-notes-kit')) } : f))), 'ana');
  return opened;
}

const skillMdOf = (catalog: ReturnType<typeof openTest>['catalog']) => (item: ReadItem) =>
  Buffer.from(catalog.fetch({ name: item.name, version: item.version }).files.find((f) => f.path === 'SKILL.md')!.content_base64, 'base64').toString();

describe('the surface (vendored, recommended variant)', () => {
  it('is the recommended variant by default, and names the command skills-catalog', () => {
    const s = Surface.load();
    expect(s.variant).toBe(doc.recommended);
    expect(s.cli).toBe('skills-catalog');
    expect(s.serverName).toBe('skills-catalog');
  });

  it('names only catalog tools the registry has (the recommended names)', () => {
    const s = Surface.load();
    for (const op of ['search', 'get', 'versions', 'diff']) expect(Object.keys(OPERATIONS)).toContain(s.names[op]);
  });

  it.each(VARIANTS)('%s: nothing unfilled in instructions, tools, companion skills, setup text or results', (variant) => {
    const s = Surface.load(variant);
    const { catalog } = seeded();
    const md = skillMdOf(catalog);
    const shown = [
      s.instructions ?? '',
      JSON.stringify(s.toolDefs()),
      s.companionSkill('mcp'),
      s.companionSkill('cli'),
      renderSearch(s, catalog.search({ query: 'release notes' }), 'release notes'),
      renderSearch(s, catalog.search({ query: 'sourdough' }), 'sourdough'),
      renderSearch(s, catalog.search({ query: 'graphql schema' }), 'graphql schema'),
      renderSearch(s, catalog.search({}), ''),
      renderSearch(s, catalog.search({ limit: 3 }), ''),
      renderRead(s, catalog.read({ name: 'release-notes-kit' }), md),
      renderRead(s, catalog.read({ name: 'release-notes-kit', version: 1, include: 'contents' }), md),
      renderRead(s, catalog.read({ names: ['release-notes-kit', 'relase-notes-kit'] }), md),
      renderError(s, errorOf(() => catalog.read({ name: 'relase-note-draft' }))),
      renderError(s, errorOf(() => catalog.read({ name: 'deploy-to-mars' }))),
      renderError(s, errorOf(() => catalog.publish(request('release-notes-kit', historyVersion(histories.versions['h1.v3'])), 'bo'))),
      renderError(s, errorOf(() => catalog.search({ limit: 99 }))),
      renderError(s, new CatalogError('invalid_manifest', { folder: 'my-skill', problem: 'is missing description', fields: ['description'] })),
      renderError(s, toCatalogError(new Error('boom'), sandbox())),
    ];
    // Skill files inside the fences are the publisher's data (a template may well say "{{version}}"), not our words.
    const ours = (text: string) =>
      text.replace(/^--- (.+) ---\n[\s\S]*?\n--- end of \1 ---$/gm, '').replace(/"(content|body)":"(?:[^"\\]|\\.)*"/g, '');
    for (const text of shown) expect(ours(text), text.slice(0, 200)).not.toMatch(UNFILLED);
  });

  it('a template with a field the renderer lacks throws, instead of showing "{field}"', () => {
    const s = Surface.load();
    expect(() => s.format('Installed {name} v{version}.', { name: 'x' })).toThrow(/\{version\}/);
  });

  it('lists the words it is still waiting for; each fails here the moment it appears', () => {
    const s = Surface.load();
    for (const path of WORD_GAPS) expect(s.word(path), `the surface now has ${path}: wire it in render.ts and drop it from WORD_GAPS`).toBeUndefined();
  });
});

describe('internal errors (contract §9)', () => {
  it('log the traceback under $SKILLS_HOME/logs and return internal_error {log}, with no traceback in it', () => {
    const home = sandbox();
    const e = toCatalogError(new TypeError('cannot read x of undefined'), home);
    expect(e.code).toBe('internal_error');
    const log = String(e.data['log']);
    expect(log.startsWith(join(home, 'logs'))).toBe(true);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toContain('TypeError: cannot read x of undefined');
    expect(JSON.stringify(e.toJSON())).not.toMatch(/at .*\.ts:\d+/);
    expect(readdirSync(join(home, 'logs'))).toHaveLength(1);
  });

  it('pass a contract error through unchanged', () => {
    const e = new CatalogError('not_found', { name: 'x', suggestions: [] });
    expect(toCatalogError(e, sandbox())).toBe(e);
  });
});
