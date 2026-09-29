// Contract conformance for the catalog operations on the local adapters, driven by the goldens (the QA plan's
// oracles: round trip, all or nothing, append-only history, idempotent republish, discoverable, not found, limits on
// reads, only owners publish, change is visible).

import { describe, expect, it } from 'vitest';
import { refuseRealPlaces, sandbox } from './sandbox.ts';
import { catalogNameOf, filesOf, generated, historyVersion, loadGolden, rawFilesOf, type RawFile } from './golden.ts';
import { errorOf, openTest, request, snapshot, versionsIn } from './helpers.ts';
import type { ReadItem } from '../src/catalog.ts';
import { userInfo } from 'node:os';

const skills = loadGolden('skills.yaml');
const histories = loadGolden('histories.yaml');

function validFixtures(): [string, string, RawFile[]][] {
  return Object.entries<any>(skills.valid).map(([key, fx]) => {
    const files = fx.generate ? generated(key) : filesOf(fx.files)!;
    return [key, catalogNameOf(key, fx, files), files];
  });
}

describe('the fail-safe (contract §8)', () => {
  it('refuses the real home and /tmp, and allows the sandbox', () => {
    expect(() => refuseRealPlaces(userInfo().homedir)).toThrow(/fail-safe/);
    expect(() => refuseRealPlaces('/tmp')).toThrow(/fail-safe/);
    expect(refuseRealPlaces(sandbox())).toBeTruthy();
  });
});

describe('round trip: fetch and read give back exactly what was published', () => {
  it('every valid fixture: same NFC paths, bytes and modes; contents for text files; binaries never inlined', () => {
    const { catalog } = openTest();
    for (const [key, name, files] of validFixtures()) {
      const pub = catalog.publish(request(name, files), 'dev1');
      expect(pub.created, key).toBe(true);
      const got = catalog.fetch({ name, version: pub.version });
      expect(got.fingerprint).toBe(pub.fingerprint);
      const want = files.map((f) => ({ path: f.path.normalize('NFC'), mode: f.mode, b64: Buffer.from(f.bytes).toString('base64') })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      expect(got.files.map((f) => ({ path: f.path, mode: f.mode, b64: f.content_base64 })), key).toEqual(want);
      expect(catalog.fetch({ fingerprint: pub.fingerprint }).files).toEqual(got.files);
      const read = catalog.read({ name, include: 'contents' }).skills[0] as ReadItem;
      for (const f of read.files!) {
        const src = files.find((x) => x.path.normalize('NFC') === f.path)!;
        if (f.type === 'text') expect(Buffer.from(f.content!, 'utf8').equals(Buffer.from(src.bytes)), `${key} ${f.path}`).toBe(true);
        else expect(f.content).toBeUndefined();
      }
    }
    const bin = catalog.read({ name: 'binary-file', include: 'contents' }).skills[0] as ReadItem;
    expect(bin.files!.find((f) => f.path === 'logo.png')!.type).toBe('binary');
  });

  it('read with a version gives that version and the latest; catalog_size counts names, not versions', () => {
    const { catalog } = openTest();
    for (const v of ['h1.v1', 'h1.v2', 'h1.v3']) catalog.publish(request('release-note-draft', historyVersion(histories.versions[v])), 'ana');
    expect(catalog.read({ name: 'release-note-draft', version: 1 }).skills[0]).toMatchObject({ version: 1, latest_version: 3 });
    expect(catalog.read({ name: 'release-note-draft' }).skills[0]).toMatchObject({ version: 3, latest_version: 3 });
    const missing = catalog.read({ names: ['release-notes'] }).skills[0]!;
    expect('version' in missing || 'latest_version' in missing).toBe(false);
    expect(catalog.search({ query: 'release' })).toMatchObject({ catalog_size: 1, total_matches: 1 });
  });

  it('read defaults to the manifest only, with the version, publisher and date', () => {
    const { catalog } = openTest();
    catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), 'dev1');
    const item = catalog.read({ name: 'release-note-draft' }).skills[0] as ReadItem;
    expect(item).toMatchObject({ name: 'release-note-draft', version: 1, latest_version: 1, publisher: 'dev1', reviews: [] });
    expect(item.manifest.frontmatter['name']).toBe('release-note-draft');
    expect(item.manifest.body).toContain('# Release note draft');
    expect(item.files).toBeUndefined();
  });
});

describe('all or nothing: a refused publish stores nothing', () => {
  const refused: [string, any, RawFile[]][] = [];
  for (const [key, fx] of Object.entries<any>(skills.invalid)) {
    refused.push([key, fx, fx.generate ? generated(key) : fx.raw_files ? rawFilesOf(fx.raw_files) : filesOf(fx.files)!]);
  }
  for (const [key, fx] of Object.entries<any>(skills.hostile)) {
    if (fx.raw_files && fx.error) refused.push([key, fx, rawFilesOf(fx.raw_files.map((f: any) => ({ ...f, path: String(f.path).replace('$RUN', '/sandbox') })))]);
  }
  it.each(refused.map(([k, fx, files]) => [k, fx.error, fx, files] as const))('%s → %s, storage unchanged', (key, code, fx, files) => {
    const { dir, catalog } = openTest();
    catalog.publish(request('minimal', filesOf(skills.valid.minimal.files)!), 'dev1');
    const before = snapshot(dir);
    const e = errorOf(() => catalog.publish(request(catalogNameOf(key, fx, files), files), 'dev1'));
    expect(e.code).toBe(code);
    if (fx.fields) expect(e.data['fields']).toEqual(fx.fields);
    if (fx.limit) expect(e.data['limit']).toBe(fx.limit);
    expect(snapshot(dir)).toBe(before);
  });

  it('a request that is not base64, or has unknown fields, is invalid_request naming the field', () => {
    const { dir, catalog } = openTest();
    const before = snapshot(dir);
    const bad = { name: 'x', files: [{ path: 'SKILL.md', mode: '0644', content_base64: '%%%' }] };
    expect(errorOf(() => catalog.publish(bad, 'dev1')).data).toMatchObject({ field: 'files[0].content_base64' });
    expect(errorOf(() => catalog.publish({ ...bad, publisher: 'eve' }, 'dev1')).data).toMatchObject({ field: 'publisher', why: 'unknown field' });
    expect(snapshot(dir)).toBe(before);
  });
});

describe('histories (golden/histories.yaml)', () => {
  it('h1: append-only history, idempotent republish, a revert, a malformed version refused, a dry run', () => {
    const { dir, catalog } = openTest();
    const h = histories.histories.h1;
    for (const step of h.steps) {
      const files = historyVersion(histories.versions[step.publish]);
      const before = snapshot(dir);
      const exp = step.expect;
      if (exp.error) {
        const e = errorOf(() => catalog.publish(request(h.name, files, { message: `publish ${step.publish}` }), 'ana'));
        expect(e.code).toBe(exp.error);
        if (exp.fields) expect(e.data['fields']).toEqual(exp.fields);
      } else {
        const r = catalog.publish(request(h.name, files, { message: `publish ${step.publish}`, ...(step.dry_run ? { dry_run: true } : {}) }), 'ana');
        expect(r.created, step.publish).toBe(exp.created);
        if (exp.version) expect(r.version).toBe(exp.version);
        if (exp.fingerprint_equals) {
          expect(r.fingerprint).toBe(catalog.fetch({ name: h.name, version: 1 }).fingerprint);
        }
        if (exp.diff_from_latest) {
          const changed = r.diff_from_latest!.files.filter((f) => f.status === 'changed').map((f) => f.path);
          expect(changed).toEqual(exp.diff_from_latest.changed);
        }
      }
      if (exp.storage_unchanged) expect(snapshot(dir)).toBe(before);
      if (exp.versions) expect(versionsIn(dir, h.name)).toEqual(exp.versions);
      if (exp.latest) expect(catalog.versions({ name: h.name }).latest).toBe(exp.latest);
      if (exp.get_version) {
        for (const [v, ref] of Object.entries<string>(exp.get_version)) {
          const want = historyVersion(histories.versions[ref]);
          const got = catalog.fetch({ name: h.name, version: Number(v) });
          expect(got.files.map((f) => f.path)).toEqual(want.map((f) => f.path).sort());
        }
      }
    }
    const list = catalog.versions({ name: h.name });
    expect(list.versions.map((v) => v.version)).toEqual([5, 4, 3, 2, 1]);
    expect(list.versions.map((v) => v.message)).toEqual(['publish h1.v1', 'publish h1.v4', 'publish h1.v3', 'publish h1.v2', 'publish h1.v1']);
    expect(list.versions.every((v) => v.publisher === 'ana')).toBe(true);
  });

  it('diffs through the catalog equal the golden diffs, with risk flags', () => {
    const { catalog } = openTest();
    for (const [, h] of Object.entries<any>(histories.histories)) {
      if (!h.diffs) continue;
      const prefix = h.name === 'release-note-draft' ? 'h1' : 'prc';
      for (let v = 1; histories.versions[`${prefix}.v${v}`]; v++) catalog.publish(request(h.name, historyVersion(histories.versions[`${prefix}.v${v}`])), 'ana');
      for (const d of h.diffs) {
        const got = catalog.diff({ name: h.name, from: d.from, to: d.to });
        expect(got.files.map((f) => ({ path: f.path, status: f.status }))).toEqual(d.files.map((f: any) => ({ path: f.path, status: f.status })));
        expect(got.risk_flags.map((r) => ({ kind: r.kind, path: r.path }))).toEqual(d.risk_flags);
      }
    }
  });

  it('a stale expected_latest is a conflict and stores nothing; the right one publishes', () => {
    const { dir, catalog } = openTest();
    const base = historyVersion(histories.versions['prc.v1']);
    const variant = (n: number) => base.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from(`Variant ${n}.\n`)]) } : f));
    for (let n = 1; n <= 20; n++) catalog.publish(request('pr-review-checklist', variant(n)), 'ana');
    const before = snapshot(dir);
    const e = errorOf(() => catalog.publish(request('pr-review-checklist', variant(21), { expected_latest: 19 }), 'ana'));
    expect(e.code).toBe('conflict');
    expect(e.data['latest']).toBe(20);
    expect(snapshot(dir)).toBe(before);
    expect(catalog.publish(request('pr-review-checklist', variant(21), { expected_latest: 20 }), 'ana')).toMatchObject({ created: true, version: 21 });
  });
});

describe('only owners publish (contract §7)', () => {
  it('the first publisher owns the name; anyone else gets not_owner and nothing is stored', () => {
    const { dir, catalog } = openTest();
    const v1 = historyVersion(histories.versions['prc.v1']);
    const v2 = historyVersion(histories.versions['prc.v2']);
    expect(catalog.publish(request('pr-review-checklist', v1), 'dev1').publisher).toBe('dev1');
    const before = snapshot(dir);
    for (const dry of [false, true]) {
      const e = errorOf(() => catalog.publish(request('pr-review-checklist', v2, { dry_run: dry }), 'dev2'));
      expect(e.code).toBe('not_owner');
      expect(e.data['owners']).toEqual(['dev1']);
    }
    expect(snapshot(dir)).toBe(before);
    expect(catalog.publish(request('pr-review-checklist', v2), 'dev1')).toMatchObject({ created: true, version: 2, publisher: 'dev1' });
    expect(catalog.read({ name: 'pr-review-checklist' }).skills[0]).toMatchObject({ publisher: 'dev1' });
  });

  it('refusals come in one order, dry run or not: not_owner, then conflict, then validation', () => {
    const { dir, catalog } = openTest();
    catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), 'dev1');
    const before = snapshot(dir);
    const broken = filesOf({ 'SKILL.md': '---\nname: pr-review-checklist\n---\n\n' })!;
    for (const dry of [false, true]) {
      expect(errorOf(() => catalog.publish(request('pr-review-checklist', broken, { dry_run: dry, expected_latest: 0 }), 'dev2')).code).toBe('not_owner');
      expect(errorOf(() => catalog.publish(request('pr-review-checklist', broken, { dry_run: dry, expected_latest: 0 }), 'dev1')).code).toBe('conflict');
      expect(errorOf(() => catalog.publish(request('pr-review-checklist', broken, { dry_run: dry }), 'dev1')).code).toBe('invalid_manifest');
    }
    expect(snapshot(dir)).toBe(before);
  });

  it('the publisher is the acting identity: none is unauthenticated, a bad one is refused', () => {
    const { catalog } = openTest();
    const v1 = historyVersion(histories.versions['prc.v1']);
    expect(errorOf(() => catalog.publish(request('pr-review-checklist', v1), undefined)).code).toBe('unauthenticated');
    expect(errorOf(() => catalog.publish(request('pr-review-checklist', v1), 'Not A Name')).code).toBe('invalid_request');
  });
});

describe('dry run (contract §2)', () => {
  it('validates, fingerprints and diffs against the latest, and stores nothing', () => {
    const { dir, catalog } = openTest();
    catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v2'])), 'ana');
    const before = snapshot(dir);
    const r = catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v3']), { dry_run: true }), 'ana');
    expect(r).toMatchObject({ created: false, dry_run: true, version: 2 });
    expect(r.risk_flags.map((f) => f.kind)).toEqual(['runnable_file']);
    expect(snapshot(dir)).toBe(before);
    expect(errorOf(() => catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['h1.malformed']), { dry_run: true }), 'ana')).code).toBe('invalid_manifest');
  });
});

describe('not found (golden/skills.yaml missing-names)', () => {
  it('a missing name is not_found with spelling-only suggestions; a bad name is invalid_name', () => {
    const { catalog } = openTest();
    catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), 'ana');
    catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), 'ana');
    for (const m of skills['missing-names']) {
      for (const op of [() => catalog.read({ name: m.name }), () => catalog.versions({ name: m.name }), () => catalog.diff({ name: m.name, from: 1, to: 1 })]) {
        const e = errorOf(op);
        expect(e.code, m.name).toBe(m.error);
        if (m.error === 'not_found') expect(e.data['suggestions'], m.name).toEqual(m.suggestions);
      }
    }
    expect(errorOf(() => catalog.read({ name: 'release-note-draft', version: 9 })).code).toBe('not_found');
    expect(errorOf(() => catalog.fetch({ fingerprint: 'sha256:' + '0'.repeat(64) })).code).toBe('not_found');
  });

  it('several names: each missing one is its own not_found, never an empty success', () => {
    const { catalog } = openTest();
    catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), 'ana');
    const r = catalog.read({ names: ['release-note-draft', 'relase-note-draft'] });
    expect(r.skills[0]).toMatchObject({ name: 'release-note-draft', version: 1 });
    expect(r.skills[1]).toEqual({ name: 'relase-note-draft', error: { code: 'not_found', name: 'relase-note-draft', suggestions: ['release-note-draft'] } });
  });
});

describe('limits on reads are errors, never clamped (contract §9)', () => {
  it('21 names, a limit of 51 or 0, both name and names: invalid_request naming the field and the limit', () => {
    const { catalog } = openTest();
    const names = Array.from({ length: 21 }, (_, i) => `s${i}`);
    expect(errorOf(() => catalog.read({ names })).data).toMatchObject({ field: 'names', limit: 20, value: 21 });
    expect(errorOf(() => catalog.search({ query: 'x', limit: 51 })).data).toMatchObject({ field: 'limit', limit: 50, value: 51 });
    expect(errorOf(() => catalog.search({ limit: 0 })).code).toBe('invalid_request');
    expect(errorOf(() => catalog.read({ name: 'a', names: ['a'] })).code).toBe('invalid_request');
    expect(errorOf(() => catalog.search({ cursor: 'not-ours' })).data).toMatchObject({ field: 'cursor' });
    expect(catalog.read({ names: names.slice(0, 20) }).skills).toHaveLength(20);
  });
});

describe('search: discoverable, any word, and says how it matched (contract §2)', () => {
  const md = (name: string, description: string, extra = '') => filesOf({ 'SKILL.md': `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody.\n` })!;

  it('finds a skill right after its publish, and shows the new description after a new version', () => {
    const { catalog } = openTest();
    catalog.publish(request('sql-migration-writer', md('sql-migration-writer', 'Writes reversible SQL schema migrations.')), 'ana');
    expect(catalog.search({ query: 'migrations' }).results.map((c) => c.name)).toEqual(['sql-migration-writer']);
    catalog.publish(request('sql-migration-writer', md('sql-migration-writer', 'Writes reversible SQL schema migrations for Postgres.')), 'ana');
    const card = catalog.search({ query: 'postgres' }).results[0]!;
    expect(card).toMatchObject({ name: 'sql-migration-writer', latest_version: 2, description: 'Writes reversible SQL schema migrations for Postgres.', matched_words: ['postgres'] });
  });

  it('match is all, partial or none; matched_words says which content words each card has', () => {
    const { catalog } = openTest();
    catalog.publish(request('sql-migration-writer', md('sql-migration-writer', 'Writes reversible SQL schema migrations.')), 'ana');
    catalog.publish(request('graphql-client', md('graphql-client', 'Calls a GraphQL API.')), 'bo');
    const partial = catalog.search({ query: 'avro schema registry' });
    expect(partial).toMatchObject({ match: 'partial', ranking: 'lexical', total_matches: 1 });
    expect(partial.results[0]!.matched_words).toEqual(['schema']);
    expect(catalog.search({ query: 'is there a skill for sql migrations' })).toMatchObject({ match: 'all' });
    expect(catalog.search({ query: 'sourdough' })).toMatchObject({ match: 'none', results: [], total_matches: 0, catalog_size: 2 });
    const all = catalog.search({});
    expect(all).toMatchObject({ ranking: 'none', match: 'all' });
    expect(all.results.map((c) => c.name)).toEqual(['graphql-client', 'sql-migration-writer']);
  });

  it('filters by tags and publisher, and pages with a cursor', () => {
    const { catalog } = openTest();
    for (let i = 0; i < 12; i++) {
      catalog.publish(request(`note-${i}`, md(`note-${i}`, `Writes notes number ${i}.`, i % 2 ? 'tags: [docs, writing]\n' : 'tags: [docs]\n')), i < 6 ? 'ana' : 'bo');
    }
    expect(catalog.search({ query: 'notes', filters: { tags: ['docs', 'writing'] } }).total_matches).toBe(6);
    expect(catalog.search({ query: 'notes', filters: { publisher: 'bo' } }).total_matches).toBe(6);
    const first = catalog.search({ query: 'notes', limit: 5 });
    expect(first.results).toHaveLength(5);
    const second = catalog.search({ query: 'notes', limit: 5, cursor: first.next_cursor! });
    const third = catalog.search({ query: 'notes', limit: 5, cursor: second.next_cursor! });
    expect(third.next_cursor).toBeUndefined();
    const seen = [...first.results, ...second.results, ...third.results].map((c) => c.name);
    expect(new Set(seen).size).toBe(12);
  });

  it('cards carry no fingerprint or timestamps', () => {
    const { catalog } = openTest();
    catalog.publish(request('minimal', filesOf(skills.valid.minimal.files)!), 'ana');
    expect(Object.keys(catalog.search({ query: 'smallest' }).results[0]!).sort()).toEqual(['description', 'latest_version', 'matched_words', 'name', 'publisher', 'tags']);
  });

  it('query words are never read as FTS5 syntax', () => {
    const { catalog } = openTest();
    catalog.publish(request('minimal', filesOf(skills.valid.minimal.files)!), 'ana');
    for (const q of ['"', 'NEAR(a b)', 'smallest OR', '* ^ :', 'description:smallest', '(']) expect(() => catalog.search({ query: q }), q).not.toThrow();
  });
});

describe('SKILLS_CATALOG (contract §8)', () => {
  it('file:// opens the local catalog; https:// (hosted, not built yet) and anything else are refused', async () => {
    const { openCatalog } = await import('../src/local/index.ts');
    const { pathToFileURL } = await import('node:url');
    const dir = sandbox();
    const c = openCatalog(pathToFileURL(dir + '/catalog').href);
    expect(c.search({}).catalog_size).toBe(0);
    c.close();
    expect(errorOf(() => openCatalog('https://catalog.example.invalid')).code).toBe('forbidden');
    expect(errorOf(() => openCatalog('/just/a/path')).code).toBe('invalid_request');
  });
});

describe('the platform (contract §8)', () => {
  it('node:sqlite has FTS5', async () => {
    const { fts5Works } = await import('../src/local/db.ts');
    expect(fts5Works()).toBe(true);
  });
});
