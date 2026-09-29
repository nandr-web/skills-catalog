// Contract conformance for the catalog operations on the local adapters, driven by the goldens (the QA plan's
// oracles: round trip, all or nothing, append-only history, idempotent republish, discoverable, not found, limits on
// reads, only owners publish, change is visible).

import { describe, expect, it } from 'vitest';
import { refuseRealPlaces, sandbox } from './sandbox.ts';
import { catalogNameOf, filesOf, generated, historyVersion, loadGolden, rawFilesOf, type RawFile } from './golden.ts';
import { errorOf, openTest, request, snapshot, versionsIn } from './helpers.ts';
import type { ReadItem } from '../src/catalog.ts';
import { actAs } from '../src/local/index.ts';
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
  it('refuses the real home and /tmp, and allows the sandbox', async () => {
    expect(() => refuseRealPlaces(userInfo().homedir)).toThrow(/fail-safe/);
    expect(() => refuseRealPlaces('/tmp')).toThrow(/fail-safe/);
    expect(refuseRealPlaces(sandbox())).toBeTruthy();
  });

  it('with the temp folder at /tmp (Linux): allows only its own test folders there, and never the home', async () => {
    const { mkdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const root = sandbox();
    const tmp = join(root, 'tmp'); // stands in for Linux's /tmp
    const home = join(root, 'home');
    const ours = join(tmp, 'skills-catalog-test-abc123');
    const theirs = join(tmp, 'someone-else');
    for (const d of [tmp, home, ours, theirs, join(home, 'skills-catalog-test-x')]) mkdirSync(d, { recursive: true });
    expect(refuseRealPlaces(ours, home, tmp, [])).toBeTruthy();
    expect(() => refuseRealPlaces(theirs, home, tmp, [])).toThrow(/fail-safe/);
    expect(() => refuseRealPlaces(tmp, home, tmp, [])).toThrow(/fail-safe/);
    expect(() => refuseRealPlaces(join(home, 'skills-catalog-test-x'), home, tmp, [])).toThrow(/real home/);
    // A temp folder inside the home (a Mac with TMPDIR under ~): the home still wins.
    const tmpInHome = join(home, 'T');
    mkdirSync(join(tmpInHome, 'skills-catalog-test-y'), { recursive: true });
    expect(() => refuseRealPlaces(join(tmpInHome, 'skills-catalog-test-y'), home, tmpInHome, [])).toThrow(/real home/);
  });
});

describe('round trip: fetch and read give back exactly what was published', () => {
  it('every valid fixture: same NFC paths, bytes and modes; contents for text files; binaries never inlined', async () => {
    const { catalog } = (await openTest());
    for (const [key, name, files] of validFixtures()) {
      const pub = (await catalog.publish(request(name, files), actAs('dev1')));
      expect(pub.created, key).toBe(true);
      const got = (await catalog.fetch({ name, version: pub.version }));
      expect(got.fingerprint).toBe(pub.fingerprint);
      const want = files.map((f) => ({ path: f.path.normalize('NFC'), mode: f.mode, b64: Buffer.from(f.bytes).toString('base64') })).sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
      expect(got.files.map((f) => ({ path: f.path, mode: f.mode, b64: f.content_base64 })), key).toEqual(want);
      expect((await catalog.fetch({ fingerprint: pub.fingerprint })).files).toEqual(got.files);
      const read = (await catalog.read({ name, include: 'contents' })).skills[0] as ReadItem;
      for (const f of read.files!) {
        const src = files.find((x) => x.path.normalize('NFC') === f.path)!;
        // Text past the read's inline budget is left out whole (fetch above already checked every byte).
        if (f.type === 'text' && !f.content_omitted) expect(Buffer.from(f.content!, 'utf8').equals(Buffer.from(src.bytes)), `${key} ${f.path}`).toBe(true);
        else expect(f.content).toBeUndefined();
      }
    }
    const bin = (await catalog.read({ name: 'binary-file', include: 'contents' })).skills[0] as ReadItem;
    expect(bin.files!.find((f) => f.path === 'logo.png')!.type).toBe('binary');
  });

  it('a read inlines at most 24 KB: each file whole or omitted, SKILL.md first, and paths[] reads the rest', async () => {
    const { catalog } = await openTest();
    const kb = (n: number, c: string) => c.repeat(n * 1024);
    const md = (name: string, body: string) => `---\nname: ${name}\ndescription: A skill with big files.\n---\n${body}\n`;
    const files = (name: string, body: string, extra: Record<string, string>) =>
      [{ path: 'SKILL.md', bytes: md(name, body) }, ...Object.entries(extra).map(([path, bytes]) => ({ path, bytes }))].map((f) => ({
        path: f.path,
        mode: '0644',
        content_base64: Buffer.from(f.bytes).toString('base64'),
      }));
    await catalog.publish({ name: 'big-one', files: files('big-one', kb(10, 'a'), { 'a.md': kb(12, 'b'), 'b.md': kb(4, 'c'), 'c.md': kb(1, 'd') }) }, actAs('ana'));
    await catalog.publish({ name: 'big-two', files: files('big-two', kb(8, 'e'), {}) }, actAs('ana'));

    // One skill: SKILL.md (10 KB) first, then by path: a.md (12 KB) fits (22), b.md (4 KB) doesn't, c.md (1 KB) still does.
    const r = await catalog.read({ name: 'big-one', include: 'contents' });
    const byPath = Object.fromEntries((r.skills[0] as ReadItem).files!.map((f) => [f.path, f]));
    expect(byPath['SKILL.md']!.content).toBeDefined();
    expect(byPath['a.md']!.content).toBeDefined();
    expect(byPath['b.md']).toMatchObject({ content_omitted: true });
    expect(byPath['b.md']!.content).toBeUndefined();
    expect(byPath['c.md']!.content).toBeDefined();
    expect(r.inline_budget).toEqual({ limit: 24 * 1024, used: (r.inline_budget!.used), omitted: 1 });
    expect(r.inline_budget!.used).toBeLessThanOrEqual(24 * 1024);

    // Several skills: every SKILL.md first, in the order asked, before any other file.
    const both = await catalog.read({ names: ['big-two', 'big-one'], include: 'contents' });
    const [two, one] = both.skills as ReadItem[];
    expect(two!.files!.find((f) => f.path === 'SKILL.md')!.content).toBeDefined();
    expect(one!.files!.find((f) => f.path === 'SKILL.md')!.content).toBeDefined();
    expect(one!.files!.find((f) => f.path === 'a.md')!.content_omitted).toBe(true);

    // paths[]: only those files, read whole; with names, or a path the version doesn't have, it's refused.
    const rest = await catalog.read({ name: 'big-one', paths: ['b.md'] });
    expect((rest.skills[0] as ReadItem).files!.map((f) => [f.path, f.content?.length])).toEqual([['b.md', 4 * 1024]]);
    expect((await errorOf(() => catalog.read({ names: ['big-one'], paths: ['b.md'] }))).data).toMatchObject({ field: 'paths' });
    expect((await errorOf(() => catalog.read({ name: 'big-one', paths: ['nope.md'] }))).data).toMatchObject({ path: 'nope.md' });
    expect((await errorOf(() => catalog.read({ name: 'big-one', paths: Array.from({ length: 21 }, (_, i) => `f${i}`) }))).data).toMatchObject({ field: 'paths', limit: 20 });
  });

  it('read with a version gives that version and the latest; catalog_size counts names, not versions', async () => {
    const { catalog } = (await openTest());
    for (const v of ['h1.v1', 'h1.v2', 'h1.v3']) (await catalog.publish(request('release-note-draft', historyVersion(histories.versions[v])), actAs('ana')));
    expect((await catalog.read({ name: 'release-note-draft', version: 1 })).skills[0]).toMatchObject({ version: 1, latest_version: 3 });
    expect((await catalog.read({ name: 'release-note-draft' })).skills[0]).toMatchObject({ version: 3, latest_version: 3 });
    const missing = (await catalog.read({ names: ['release-notes'] })).skills[0]!;
    expect('version' in missing || 'latest_version' in missing).toBe(false);
    expect((await catalog.search({ query: 'release' }))).toMatchObject({ catalog_size: 1, total_matches: 1 });
  });

  it('read defaults to the manifest only, with the version, publisher and date', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), actAs('dev1')));
    const item = (await catalog.read({ name: 'release-note-draft' })).skills[0] as ReadItem;
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
  it.each(refused.map(([k, fx, files]) => [k, fx.error, fx, files] as const))('%s → %s, storage unchanged', async (key, code, fx, files) => {
    const { dir, catalog } = (await openTest());
    (await catalog.publish(request('minimal', filesOf(skills.valid.minimal.files)!), actAs('dev1')));
    const before = snapshot(dir);
    const e = (await errorOf(async () => (await catalog.publish(request(catalogNameOf(key, fx, files), files), actAs('dev1')))));
    expect(e.code).toBe(code);
    if (fx.fields) expect(e.data['fields']).toEqual(fx.fields);
    if (fx.limit) expect(e.data['limit']).toBe(fx.limit);
    expect(snapshot(dir)).toBe(before);
  });

  it('a request that is not base64, or has unknown fields, is invalid_request naming the field', async () => {
    const { dir, catalog } = (await openTest());
    const before = snapshot(dir);
    const bad = { name: 'x', files: [{ path: 'SKILL.md', mode: '0644', content_base64: '%%%' }] };
    expect((await errorOf(async () => (await catalog.publish(bad, actAs('dev1'))))).data).toMatchObject({ field: 'files[0].content_base64' });
    expect((await errorOf(async () => (await catalog.publish({ ...bad, publisher: 'eve' }, actAs('dev1'))))).data).toMatchObject({ field: 'publisher', why: 'unknown_field' });
    expect(snapshot(dir)).toBe(before);
  });
});

describe('histories (golden/histories.yaml)', () => {
  it('h1: append-only history, idempotent republish, a revert, a malformed version refused, a dry run', async () => {
    const { dir, catalog } = (await openTest());
    const h = histories.histories.h1;
    for (const step of h.steps) {
      const files = historyVersion(histories.versions[step.publish]);
      const before = snapshot(dir);
      const exp = step.expect;
      if (exp.error) {
        const e = (await errorOf(async () => (await catalog.publish(request(h.name, files, { message: `publish ${step.publish}` }), actAs('ana')))));
        expect(e.code).toBe(exp.error);
        if (exp.fields) expect(e.data['fields']).toEqual(exp.fields);
      } else {
        const r = (await catalog.publish(request(h.name, files, { message: `publish ${step.publish}`, ...(step.dry_run ? { dry_run: true } : {}) }), actAs('ana')));
        expect(r.created, step.publish).toBe(exp.created);
        if (exp.version) expect(r.version).toBe(exp.version);
        if (exp.fingerprint_equals) {
          expect(r.fingerprint).toBe((await catalog.fetch({ name: h.name, version: 1 })).fingerprint);
        }
        if (exp.diff_from_latest) {
          const changed = r.diff_from_latest!.files.filter((f) => f.status === 'changed').map((f) => f.path);
          expect(changed).toEqual(exp.diff_from_latest.changed);
        }
      }
      if (exp.storage_unchanged) expect(snapshot(dir)).toBe(before);
      if (exp.versions) expect(versionsIn(dir, h.name)).toEqual(exp.versions);
      if (exp.latest) expect((await catalog.versions({ name: h.name })).latest).toBe(exp.latest);
      if (exp.get_version) {
        for (const [v, ref] of Object.entries<string>(exp.get_version)) {
          const want = historyVersion(histories.versions[ref]);
          const got = (await catalog.fetch({ name: h.name, version: Number(v) }));
          expect(got.files.map((f) => f.path)).toEqual(want.map((f) => f.path).sort());
        }
      }
    }
    const list = (await catalog.versions({ name: h.name }));
    expect(list.versions.map((v) => v.version)).toEqual([5, 4, 3, 2, 1]);
    expect(list.versions.map((v) => v.message)).toEqual(['publish h1.v1', 'publish h1.v4', 'publish h1.v3', 'publish h1.v2', 'publish h1.v1']);
    expect(list.versions.every((v) => v.publisher === 'ana')).toBe(true);
  });

  it('diffs through the catalog equal the golden diffs, with risk flags', async () => {
    const { catalog } = (await openTest());
    for (const [, h] of Object.entries<any>(histories.histories)) {
      if (!h.diffs) continue;
      const prefix = h.name === 'release-note-draft' ? 'h1' : 'prc';
      for (let v = 1; histories.versions[`${prefix}.v${v}`]; v++) (await catalog.publish(request(h.name, historyVersion(histories.versions[`${prefix}.v${v}`])), actAs('ana')));
      for (const d of h.diffs) {
        const got = (await catalog.diff({ name: h.name, from: d.from, to: d.to }));
        expect(got.files.map((f) => ({ path: f.path, status: f.status }))).toEqual(d.files.map((f: any) => ({ path: f.path, status: f.status })));
        expect(got.risk_flags.map((r) => ({ kind: r.kind, path: r.path }))).toEqual(d.risk_flags);
      }
    }
  });

  it('a stale expected_latest is a conflict and stores nothing; the right one publishes', async () => {
    const { dir, catalog } = (await openTest());
    const base = historyVersion(histories.versions['prc.v1']);
    const variant = (n: number) => base.map((f) => (f.path === 'SKILL.md' ? { ...f, bytes: Buffer.concat([Buffer.from(f.bytes), Buffer.from(`Variant ${n}.\n`)]) } : f));
    for (let n = 1; n <= 20; n++) (await catalog.publish(request('pr-review-checklist', variant(n)), actAs('ana')));
    const before = snapshot(dir);
    const e = (await errorOf(async () => (await catalog.publish(request('pr-review-checklist', variant(21), { expected_latest: 19 }), actAs('ana')))));
    expect(e.code).toBe('conflict');
    expect(e.data['latest']).toBe(20);
    expect(snapshot(dir)).toBe(before);
    expect((await catalog.publish(request('pr-review-checklist', variant(21), { expected_latest: 20 }), actAs('ana')))).toMatchObject({ created: true, version: 21 });
  });
});

describe('the secret scan in the core\'s publish (contract §2)', () => {
  const md = '---\nname: keys\ndescription: Calls an API.\n---\nRun scripts/call.sh.\n';
  const withScript = (script: string) => [
    { path: 'SKILL.md', mode: '0644', bytes: Buffer.from(md) },
    { path: 'scripts/call.sh', mode: '0755', bytes: Buffer.from(script) },
  ];

  it('refuses a secret in a script, names the file and line, never the value, and stores nothing, dry run or not', async () => {
    const { dir, catalog } = await openTest();
    const key = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    const before = snapshot(dir);
    for (const dry of [false, true]) {
      const e = await errorOf(() => catalog.publish(request('keys', withScript(`#!/bin/sh\n\ncurl -H "Authorization: ${key}" x\n`), { dry_run: dry }), actAs('ana')));
      expect(e.toJSON()).toEqual({ code: 'secret_suspected', path: 'scripts/call.sh', line: 3, kind: 'github_token' });
      expect(JSON.stringify(e.toJSON())).not.toContain(key);
    }
    expect(snapshot(dir)).toBe(before);
  });

  it('flags AWS\'s documented example key by its shape, and lets it through only on the person\'s override', async () => {
    const { catalog } = await openTest();
    const files = withScript('#!/bin/sh\nexport AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n');
    expect((await errorOf(() => catalog.publish(request('keys', files), actAs('ana')))).data).toMatchObject({ kind: 'aws_access_key', line: 2 });
    expect(await catalog.publish(request('keys', files, { allow_suspected_secrets: true }), actAs('ana'))).toMatchObject({ created: true, version: 1 });
  });

  it('leaves ordinary text alone', async () => {
    const { catalog } = await openTest();
    const files = withScript('#!/bin/sh\n# the token comes from the environment\necho "$API_TOKEN" > /dev/null\n');
    expect((await catalog.publish(request('keys', files), actAs('ana'))).created).toBe(true);
  });
});

describe('only owners publish (contract §7)', () => {
  it('the first publisher owns the name; anyone else gets not_owner and nothing is stored', async () => {
    const { dir, catalog } = (await openTest());
    const v1 = historyVersion(histories.versions['prc.v1']);
    const v2 = historyVersion(histories.versions['prc.v2']);
    expect((await catalog.publish(request('pr-review-checklist', v1), actAs('dev1'))).publisher).toBe('dev1');
    const before = snapshot(dir);
    for (const dry of [false, true]) {
      const e = (await errorOf(async () => (await catalog.publish(request('pr-review-checklist', v2, { dry_run: dry }), actAs('dev2')))));
      expect(e.code).toBe('not_owner');
      expect(e.data['owners']).toEqual(['dev1']);
    }
    expect(snapshot(dir)).toBe(before);
    expect((await catalog.publish(request('pr-review-checklist', v2), actAs('dev1')))).toMatchObject({ created: true, version: 2, publisher: 'dev1' });
    expect((await catalog.read({ name: 'pr-review-checklist' })).skills[0]).toMatchObject({ publisher: 'dev1' });
  });

  it('refusals come in one order, dry run or not: not_owner, then conflict, then validation', async () => {
    const { dir, catalog } = (await openTest());
    (await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), actAs('dev1')));
    const before = snapshot(dir);
    const broken = filesOf({ 'SKILL.md': '---\nname: pr-review-checklist\n---\n\n' })!;
    for (const dry of [false, true]) {
      expect((await errorOf(async () => (await catalog.publish(request('pr-review-checklist', broken, { dry_run: dry, expected_latest: 0 }), actAs('dev2'))))).code).toBe('not_owner');
      expect((await errorOf(async () => (await catalog.publish(request('pr-review-checklist', broken, { dry_run: dry, expected_latest: 0 }), actAs('dev1'))))).code).toBe('conflict');
      expect((await errorOf(async () => (await catalog.publish(request('pr-review-checklist', broken, { dry_run: dry }), actAs('dev1'))))).code).toBe('invalid_manifest');
    }
    expect(snapshot(dir)).toBe(before);
  });

  it('the publisher is the acting identity: none is unauthenticated, a bad one is refused', async () => {
    const { catalog } = (await openTest());
    const v1 = historyVersion(histories.versions['prc.v1']);
    expect((await errorOf(async () => (await catalog.publish(request('pr-review-checklist', v1), actAs(undefined))))).code).toBe('unauthenticated');
    expect((await errorOf(async () => (await catalog.publish(request('pr-review-checklist', v1), actAs('Not A Name'))))).code).toBe('invalid_request');
  });
});

describe('dry run (contract §2)', () => {
  it('validates, fingerprints and diffs against the latest, and stores nothing', async () => {
    const { dir, catalog } = (await openTest());
    (await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v2'])), actAs('ana')));
    const before = snapshot(dir);
    const r = (await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v3']), { dry_run: true }), actAs('ana')));
    expect(r).toMatchObject({ created: false, dry_run: true, version: 2 });
    expect(r.risk_flags.map((f) => f.kind)).toEqual(['runnable_file']);
    expect(snapshot(dir)).toBe(before);
    expect((await errorOf(async () => (await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['h1.malformed']), { dry_run: true }), actAs('ana'))))).code).toBe('invalid_manifest');
  });
});

describe('not found (golden/skills.yaml missing-names)', () => {
  it('a missing name is not_found with spelling-only suggestions; a bad name is invalid_name', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), actAs('ana')));
    (await catalog.publish(request('pr-review-checklist', historyVersion(histories.versions['prc.v1'])), actAs('ana')));
    for (const m of skills['missing-names']) {
      for (const op of [async () => (await catalog.read({ name: m.name })), async () => (await catalog.versions({ name: m.name })), async () => (await catalog.diff({ name: m.name, from: 1, to: 1 }))]) {
        const e = await errorOf(op);
        expect(e.code, m.name).toBe(m.error);
        if (m.error === 'not_found') expect(e.data['suggestions'], m.name).toEqual(m.suggestions);
      }
    }
    expect((await errorOf(async () => (await catalog.read({ name: 'release-note-draft', version: 9 })))).code).toBe('not_found');
    expect((await errorOf(async () => (await catalog.fetch({ fingerprint: 'sha256:' + '0'.repeat(64) })))).code).toBe('not_found');
  });

  it('several names: each missing one is its own not_found, never an empty success', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('release-note-draft', historyVersion(histories.versions['h1.v1'])), actAs('ana')));
    const r = (await catalog.read({ names: ['release-note-draft', 'relase-note-draft'] }));
    expect(r.skills[0]).toMatchObject({ name: 'release-note-draft', version: 1 });
    expect(r.skills[1]).toEqual({ name: 'relase-note-draft', error: { code: 'not_found', name: 'relase-note-draft', suggestions: ['release-note-draft'] } });
  });
});

describe('limits on reads are errors, never clamped (contract §9)', () => {
  it('21 names, a limit of 51 or 0, both name and names: invalid_request naming the field and the limit', async () => {
    const { catalog } = (await openTest());
    const names = Array.from({ length: 21 }, (_, i) => `s${i}`);
    expect((await errorOf(async () => (await catalog.read({ names })))).data).toMatchObject({ field: 'names', limit: 20, value: 21 });
    expect((await errorOf(async () => (await catalog.search({ query: 'x', limit: 51 })))).data).toMatchObject({ field: 'limit', limit: 50, value: 51 });
    expect((await errorOf(async () => (await catalog.search({ limit: 0 })))).code).toBe('invalid_request');
    expect((await errorOf(async () => (await catalog.read({ name: 'a', names: ['a'] })))).code).toBe('invalid_request');
    expect((await errorOf(async () => (await catalog.search({ cursor: 'not-ours' })))).data).toMatchObject({ field: 'cursor' });
    expect((await catalog.read({ names: names.slice(0, 20) })).skills).toHaveLength(20);
  });

  it('a search filter takes up to 10 tags of up to 32 characters, a skill\'s own tag rule', async () => {
    const { catalog } = await openTest();
    const tags = Array.from({ length: 11 }, (_, i) => `t${i}`);
    expect((await errorOf(() => catalog.search({ filters: { tags } }))).data).toMatchObject({ field: 'filters.tags', why: 'too_many_items', limit: 10, value: 11 });
    expect((await errorOf(() => catalog.search({ filters: { tags: ['a'.repeat(33)] } }))).data).toMatchObject({ field: 'filters.tags[0]', why: 'too_long', limit: 32, value: 33 });
    expect((await catalog.search({ filters: { tags: [...tags.slice(0, 9), 'a'.repeat(32)] } })).match).toBe('none');
  });

  it('reads only the request\'s own fields: constructor, __proto__ and inherited fields never count', async () => {
    const { catalog } = await openTest();
    expect((await errorOf(() => catalog.search({ constructor: 1 }))).data).toMatchObject({ field: 'constructor', why: 'unknown_field' });
    expect((await errorOf(() => catalog.search(JSON.parse('{"__proto__": {"limit": 1}}')))).data).toMatchObject({ field: '__proto__', why: 'unknown_field' });
    expect((await errorOf(() => catalog.search({ filters: { toString: 'x' } }))).data).toMatchObject({ field: 'filters.toString', why: 'unknown_field' });
    // A required field that is only inherited is missing.
    const inherited = Object.create({ name: 'release-note-draft' });
    expect((await errorOf(() => catalog.versions(inherited))).data).toMatchObject({ field: 'name', why: 'required' });
  });
});

describe('search: discoverable, any word, and says how it matched (contract §2)', () => {
  const md = (name: string, description: string, extra = '') => filesOf({ 'SKILL.md': `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody.\n` })!;

  it('finds a skill right after its publish, and shows the new description after a new version', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('sql-migration-writer', md('sql-migration-writer', 'Writes reversible SQL schema migrations.')), actAs('ana')));
    expect((await catalog.search({ query: 'migrations' })).results.map((c) => c.name)).toEqual(['sql-migration-writer']);
    (await catalog.publish(request('sql-migration-writer', md('sql-migration-writer', 'Writes reversible SQL schema migrations for Postgres.')), actAs('ana')));
    const card = (await catalog.search({ query: 'postgres' })).results[0]!;
    expect(card).toMatchObject({ name: 'sql-migration-writer', latest_version: 2, description: 'Writes reversible SQL schema migrations for Postgres.', matched_words: ['postgres'] });
  });

  it('match is all, partial or none; matched_words says which content words each card has', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('sql-migration-writer', md('sql-migration-writer', 'Writes reversible SQL schema migrations.')), actAs('ana')));
    (await catalog.publish(request('graphql-client', md('graphql-client', 'Calls a GraphQL API.')), actAs('bo')));
    const partial = (await catalog.search({ query: 'avro schema registry' }));
    expect(partial).toMatchObject({ match: 'partial', ranking: 'lexical', total_matches: 1 });
    expect(partial.results[0]!.matched_words).toEqual(['schema']);
    expect((await catalog.search({ query: 'is there a skill for sql migrations' }))).toMatchObject({ match: 'all' });
    expect((await catalog.search({ query: 'sourdough' }))).toMatchObject({ match: 'none', results: [], total_matches: 0, catalog_size: 2 });
    const all = (await catalog.search({}));
    expect(all).toMatchObject({ ranking: 'none', match: 'all' });
    expect(all.results.map((c) => c.name)).toEqual(['graphql-client', 'sql-migration-writer']);
  });

  it('matches stemmed words, and match and matched_words stem the same way (words reported as asked)', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('pr-review-helper', md('pr-review-helper', 'Helps with reviewing pull requests.')), actAs('ana')));
    const r = (await catalog.search({ query: 'Review pull request' }));
    expect(r).toMatchObject({ match: 'all', total_matches: 1 });
    expect(r.results[0]!.matched_words).toEqual(['review', 'pull', 'request']);
  });

  it('an index built with another tokenizer is rebuilt from the versions when the catalog opens', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { openLocalCatalog } = await import('../src/local/index.ts');
    const { join } = await import('node:path');
    const { dir, catalog } = (await openTest());
    (await catalog.publish(request('pr-review-helper', md('pr-review-helper', 'Helps with reviewing pull requests.')), actAs('ana')));
    catalog.close();
    const db = new DatabaseSync(join(dir, 'catalog', 'catalog.sqlite'));
    db.exec("DROP TABLE search_fts; CREATE VIRTUAL TABLE search_fts USING fts5 (name UNINDEXED, words, description, tokenize = 'unicode61'); DELETE FROM search_cards;");
    db.close();
    const reopened = (await openLocalCatalog(join(dir, 'catalog')));
    expect((await reopened.search({ query: 'review' })).results.map((c) => c.name)).toEqual(['pr-review-helper']);
    reopened.close();
  });

  it('the faces can read a cursor\'s offset and check a developer name with the core\'s own rules', async () => {
    const { cursorOffset, checkActor } = await import('../src/catalog.ts');
    const { catalog } = await openTest();
    for (let i = 0; i < 7; i++) await catalog.publish(request(`note-${i}`, filesOf({ 'SKILL.md': `---\nname: note-${i}\ndescription: Notes ${i}.\n---\nBody.\n` })!), actAs('ana'));
    const first = await catalog.search({ limit: 3 });
    expect(cursorOffset(undefined)).toBe(0);
    expect(cursorOffset(first.next_cursor)).toBe(3);
    expect((await errorOf(() => cursorOffset('not-ours'))).data).toMatchObject({ field: 'cursor' });
    expect(checkActor('dev2')).toBe('dev2');
    expect((await errorOf(() => checkActor('Dev 2\n'))).data).toMatchObject({ field: 'as' });
    expect((await errorOf(() => checkActor(undefined))).code).toBe('unauthenticated');
  });

  it('filters by tags and publisher, and pages with a cursor', async () => {
    const { catalog } = (await openTest());
    for (let i = 0; i < 12; i++) {
      (await catalog.publish(request(`note-${i}`, md(`note-${i}`, `Writes notes number ${i}.`, i % 2 ? 'metadata:\n  tags: docs, writing, docs\n' : 'metadata:\n  tags: docs\n')), actAs(i < 6 ? 'ana' : 'bo')));
    }
    expect((await catalog.search({ query: 'notes', limit: 1, filters: { tags: ['writing'] } })).results[0]!.tags).toEqual(['docs', 'writing']);
    expect((await catalog.search({ query: 'notes', filters: { tags: ['docs', 'writing'] } })).total_matches).toBe(6);
    expect((await catalog.search({ query: 'notes', filters: { publisher: 'bo' } })).total_matches).toBe(6);
    const first = (await catalog.search({ query: 'notes', limit: 5 }));
    expect(first.results).toHaveLength(5);
    const second = (await catalog.search({ query: 'notes', limit: 5, cursor: first.next_cursor! }));
    const third = (await catalog.search({ query: 'notes', limit: 5, cursor: second.next_cursor! }));
    expect(third.next_cursor).toBeUndefined();
    const seen = [...first.results, ...second.results, ...third.results].map((c) => c.name);
    expect(new Set(seen).size).toBe(12);
  });

  it('tags: metadata.tags, one comma-separated string; a bad one is invalid_manifest {fields: [metadata.tags]}', async () => {
    const { catalog } = (await openTest());
    const bad = ['metadata:\n  tags: [docs]\n', 'metadata:\n  tags: Docs\n', `metadata:\n  tags: ${'x'.repeat(33)}\n`, `metadata:\n  tags: ${Array.from({ length: 11 }, (_, i) => `t${i}`).join(', ')}\n`, 'metadata:\n  tags: a,,b\n'];
    for (const extra of bad) {
      const e = (await errorOf(async () => (await catalog.publish(request('tagged', md('tagged', 'Has tags.', extra)), actAs('ana')))));
      expect(e.code, extra).toBe('invalid_manifest');
      expect(e.data['fields'], extra).toEqual(['metadata.tags']);
    }
    expect((await catalog.publish(request('tagged', md('tagged', 'Has tags.', `metadata:\n  tags: ${Array.from({ length: 10 }, (_, i) => `t${i}`).join(' , ')}\n  owner-team: docs\n`)), actAs('ana'))).created).toBe(true);
    expect((await catalog.search({ query: 'tags', filters: { tags: ['t0', 't9'] } })).results[0]!.tags).toHaveLength(10);
    // A top-level tags key is an ordinary key: kept, no error, not a tag; and tags are filters, not search words.
    expect((await catalog.publish(request('plain', md('plain', 'No metadata.', 'tags: [docs]\n')), actAs('ana'))).created).toBe(true);
    expect((await catalog.search({ query: 'plain', filters: { tags: ['docs'] } })).results).toEqual([]);
    expect((await catalog.search({ query: 't3' })).results).toEqual([]);
  });

  it('cards carry no fingerprint or timestamps', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('minimal', filesOf(skills.valid.minimal.files)!), actAs('ana')));
    expect(Object.keys((await catalog.search({ query: 'smallest' })).results[0]!).sort()).toEqual(['description', 'latest_version', 'matched_words', 'name', 'publisher', 'tags']);
  });

  it('query words are never read as FTS5 syntax', async () => {
    const { catalog } = (await openTest());
    (await catalog.publish(request('minimal', filesOf(skills.valid.minimal.files)!), actAs('ana')));
    for (const q of ['"', 'NEAR(a b)', 'smallest OR', '* ^ :', 'description:smallest', '(']) expect(async () => (await catalog.search({ query: q })), q).not.toThrow();
  });
});

describe('SKILLS_CATALOG (contract §8)', () => {
  it('file:// opens the local catalog; https:// (hosted, not built yet) and anything else are refused', async () => {
    const { openCatalog } = await import('../src/open.ts');
    const { pathToFileURL } = await import('node:url');
    const dir = sandbox();
    const c = (await openCatalog(pathToFileURL(dir + '/catalog').href));
    expect((await c.search({})).catalog_size).toBe(0);
    c.close();
    expect((await errorOf(async () => (await openCatalog('https://catalog.example.invalid')))).code).toBe('forbidden');
    expect((await errorOf(async () => (await openCatalog('/just/a/path')))).code).toBe('invalid_request');
  });
});

describe('the platform (contract §8)', () => {
  it('node:sqlite has FTS5', async () => {
    const { fts5Works } = await import('../src/local/db.ts');
    expect(fts5Works()).toBe(true);
  });
});
