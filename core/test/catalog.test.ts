// Contract conformance for the catalog operations on the local adapters, driven by the goldens (the QA plan's
// oracles: not found, limits on reads, the secret scan, dry run, the fail-safe). The oracles every adapter shares (round
// trip, all or nothing, append-only history, idempotent republish, only owners publish, discoverable) are in
// test/shared/catalog.ts and run on each adapter.

import { describe, expect, it } from 'vitest';
import { refuseRealPlaces, sandbox } from './sandbox.ts';
import { filesOf, historyVersion, loadGolden } from './golden.ts';
import { errorOf, openTest, request, snapshot } from './helpers.ts';
import { actAs } from '../src/local/index.ts';
import { userInfo } from 'node:os';
import { ADAPTERS } from './adapters.ts';
import { catalogSuite } from './shared/catalog.ts';

const skills = loadGolden('skills.yaml');
const histories = loadGolden('histories.yaml');
// Read before this file imports the fail-safe itself: only the run's setup file can have set it.
const guardedFromTheStart = (globalThis as Record<symbol, unknown>)[Symbol.for('skills-catalog.fail-safe')] === true;


describe('the fail-safe (contract §8)', () => {
  it('refuses reads of Claude Code\'s real managed settings, so a test that forgets SKILLS_MANAGED_SETTINGS fails', async () => {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    // /etc is a link to /private/etc on macOS: the linked-through path is refused as well.
    for (const dir of ['/Library/Application Support/ClaudeCode', '/etc/claude-code', '/private/etc/claude-code']) {
      const file = join(dir, 'managed-settings.json');
      expect(() => fs.readFileSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.openSync(file, 'r'), file).toThrow(/fail-safe/);
      expect(() => fs.lstatSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.statSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.readdirSync(join(dir, 'managed-settings.d')), dir).toThrow(/fail-safe/);
      expect(() => fs.existsSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.createReadStream(file), file).toThrow(/fail-safe/);
      expect(() => fs.readlinkSync(file), file).toThrow(/fail-safe/);
      await expect(fs.promises.readFile(file), file).rejects.toThrow(/fail-safe/);
      expect(() => fs.readFile(file, () => {}), file).toThrow(/fail-safe/);
    }
    const standIn = join(sandbox(), 'managed-settings');
    expect(fs.existsSync(join(standIn, 'managed-settings.json'))).toBe(false);
    (await import('./fail-safe.ts')).takeRefusals();
  });

  it('refuses reads of the person\'s own Claude Code files in the real home (~/.claude.json and ~/.claude), by every read call', async () => {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const home = userInfo().homedir;
    for (const file of [join(home, '.claude.json'), join(home, '.claude', 'settings.json'), join(home, '.claude')]) {
      expect(() => fs.readFileSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.lstatSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.existsSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.realpathSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.realpathSync.native(file), file).toThrow(/fail-safe/);
      expect(() => fs.statfsSync(file), file).toThrow(/fail-safe/);
      expect(() => fs.watch(file), file).toThrow(/fail-safe/);
      expect(() => fs.promises.watch(file), file).toThrow(/fail-safe/);
      expect(() => fs.globSync('*', { cwd: file }), file).toThrow(/fail-safe/);
      expect(() => fs.copyFileSync(file, join(sandbox(), 'copy')), file).toThrow(/fail-safe/);
      await expect(fs.openAsBlob(file), file).rejects.toThrow(/fail-safe/);
    }
    (await import('./fail-safe.ts')).takeRefusals();
  });

  it('checks the reads a path alone doesn\'t show: the promises watch, and glob\'s folder, pattern lists and wildcards (shown on a sandbox never read for this test)', async () => {
    const fs = await import('node:fs');
    const { join } = await import('node:path');
    const { alsoNeverRead, takeRefusals } = await import('./fail-safe.ts');
    const parent = sandbox();
    const standIn = join(parent, '.claude');
    fs.mkdirSync(standIn);
    fs.writeFileSync(join(standIn, 'settings.json'), '{}');
    const allow = alsoNeverRead(standIn);
    try {
      expect(() => fs.promises.watch(join(standIn, 'settings.json'))).toThrow(/fail-safe/);
      const globs: [string | string[], { cwd?: string }?][] = [
        ['.claude/settings.json', { cwd: parent }],
        ['settings.json', { cwd: standIn }],
        [['elsewhere.json', join(standIn, 'settings.json')]],
        [join(parent, '.cl*', 'settings.json')],
        ['*/settings.json', { cwd: parent }],
      ];
      for (const [pattern, options] of globs) {
        const what = JSON.stringify([pattern, options]);
        expect(() => fs.globSync(pattern, options ?? {}), what).toThrow(/fail-safe/);
        expect(() => fs.promises.glob(pattern, options ?? {}), what).toThrow(/fail-safe/);
        expect(() => fs.glob(pattern, options ?? {}, () => {}), what).toThrow(/fail-safe/);
      }
    } finally {
      allow();
    }
    takeRefusals();
    // A glob beside the refused folder, not above it, still runs.
    fs.mkdirSync(join(parent, 'kept'));
    fs.writeFileSync(join(parent, 'kept', 'settings.json'), '{}');
    expect(fs.globSync('kept/*.json', { cwd: parent })).toEqual([join('kept', 'settings.json')]);
  });

  it('notes every refusal, so one the code under test catches still fails that test', async () => {
    const fs = await import('node:fs');
    const { takeRefusals } = await import('./fail-safe.ts');
    try {
      fs.readFileSync('/Library/Application Support/ClaudeCode/managed-settings.json');
    } catch {
      // caught, as a reader that turns every failure into "unreadable" would
    }
    expect(takeRefusals()).toEqual([expect.stringMatching(/^fail-safe: readFileSync/)]);
  });

  it('refuses the real home and /tmp, and allows the sandbox', async () => {
    expect(() => refuseRealPlaces(userInfo().homedir)).toThrow(/fail-safe/);
    expect(() => refuseRealPlaces('/tmp')).toThrow(/fail-safe/);
    expect(refuseRealPlaces(sandbox())).toBeTruthy();
  });

  it('is run-wide: the real home, ~/.claude and Claude Code\'s /private/tmp/claude-* folders are refused in every test file', async () => {
    expect(guardedFromTheStart).toBe(true);
    const { REFUSED_ROOTS, refusedPlace } = await import('./fail-safe.ts');
    const { join } = await import('node:path');
    expect(REFUSED_ROOTS).toEqual([userInfo().homedir, join(userInfo().homedir, '.claude')]);
    for (const p of [join(userInfo().homedir, 'x'), join(userInfo().homedir, '.claude', 'skills', 'x'), '/private/tmp/claude-501/x', '/tmp/claude-501/x']) expect(refusedPlace(p), p).toBeDefined();
    expect(refusedPlace(sandbox())).toBeUndefined();
    expect(Object.keys(process.env).filter((k) => k.startsWith('SKILLS_'))).toEqual([]);
  });

  it('checks every write, through named imports, promises and SQLite alike (shown on a sandbox refused for this test)', async () => {
    const { alsoRefuse } = await import('./fail-safe.ts');
    const { mkdirSync, readdirSync, renameSync, writeFileSync } = await import('node:fs');
    const { writeFile } = await import('node:fs/promises');
    const { DatabaseSync } = await import('node:sqlite');
    const { join } = await import('node:path');
    const standIn = sandbox();
    const outside = join(sandbox(), 'a.txt');
    writeFileSync(outside, 'a');
    const allow = alsoRefuse(standIn);
    try {
      expect(() => writeFileSync(join(standIn, 'x'), 'x')).toThrow(/fail-safe/);
      expect(() => mkdirSync(join(standIn, 'd'))).toThrow(/fail-safe/);
      expect(() => renameSync(outside, join(standIn, 'a.txt'))).toThrow(/fail-safe/);
      await expect(writeFile(join(standIn, 'y'), 'y')).rejects.toThrow(/fail-safe/);
      expect(() => new DatabaseSync(join(standIn, 'c.db'))).toThrow(/fail-safe/);
      const { openCatalog } = await import('../src/open.ts');
      const { pathToFileURL } = await import('node:url');
      await expect(openCatalog(pathToFileURL(join(standIn, 'catalog')).href)).rejects.toThrow(/fail-safe/);
    } finally {
      allow();
    }
    expect(readdirSync(standIn)).toEqual([]);
    (await import('./fail-safe.ts')).takeRefusals();
  });

  it('is there for other packages\' tests: the sandbox helpers and the setup file, by name', async () => {
    const { exports } = JSON.parse((await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(Object.keys(await import(new URL(`.${exports['./testing'].slice(1)}`, new URL('../', import.meta.url)).href))).toEqual(expect.arrayContaining(['sandbox', 'refuseRealPlaces']));
    expect(Object.keys(await import(new URL(`.${exports['./testing/fail-safe'].slice(1)}`, new URL('../', import.meta.url)).href))).toEqual(expect.arrayContaining(['refusedPlace', 'REFUSED_ROOTS']));
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
    expect(await catalog.publish(request('keys', files, { allow_suspected_secrets: true }), actAs('ana'), 'cli')).toMatchObject({ created: true, version: 1 });
  });

  it('leaves ordinary text alone', async () => {
    const { catalog } = await openTest();
    const files = withScript('#!/bin/sh\n# the token comes from the environment\necho "$API_TOKEN" > /dev/null\n');
    expect((await catalog.publish(request('keys', files), actAs('ana'))).created).toBe(true);
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
  it('takes the keys known to grant nothing from its config: a key taken off the list makes a body edit ask', async () => {
    const skill = (body: string) => [{ path: 'SKILL.md', mode: '0644' as const, bytes: Buffer.from(`---\nname: tuned\ndescription: Tuned.\nmodel: opus\n---\n${body}`) }];
    for (const [nonGrantingKeys, kinds] of [[undefined, []], [[], ['instructions_changed']]] as const) {
      const { catalog } = await openTest(nonGrantingKeys ? { config: { nonGrantingKeys } } : {});
      await catalog.publish(request('tuned', skill('Old.\n')), actAs('ana'));
      const r = await catalog.publish(request('tuned', skill('New.\n'), { dry_run: true }), actAs('ana'));
      expect(r.risk_flags.map((f) => f.kind), JSON.stringify(nonGrantingKeys)).toEqual(kinds);
    }
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
    expect((await errorOf(() => catalog.search({ filters: { tags } }))).data).toMatchObject({ field: 'filters.tags', why: 'too_many', limit: 10, value: 11 });
    expect((await errorOf(() => catalog.search({ filters: { tags: ['a', 'a'.repeat(33)] } }))).data).toMatchObject({ field: 'filters.tags', why: 'too_long', limit: 32, value: 33 });
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


describe('search: the local index', () => {
  const md = (name: string, description: string, extra = '') => filesOf({ 'SKILL.md': `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody.\n` })!;

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
});

for (const a of ADAPTERS) catalogSuite(a);

describe('SKILLS_CATALOG (contract §8)', () => {
  it('file:// opens the local catalog; https:// opens a hosted one (over its web API, nothing asked at open); anything else is refused', async () => {
    const { openCatalog } = await import('../src/open.ts');
    const { pathToFileURL } = await import('node:url');
    const dir = sandbox();
    const c = (await openCatalog(pathToFileURL(dir + '/catalog').href));
    expect((await c.search({})).catalog_size).toBe(0);
    c.close();
    expect((await openCatalog('https://catalog.example.invalid', { fetch: (() => { throw new Error('asked at open'); }) as never })).where).toBe('hosted');
    expect((await errorOf(async () => (await openCatalog('/just/a/path')))).code).toBe('invalid_request');
  });
});

describe('the platform (contract §8)', () => {
  it('node:sqlite has FTS5', async () => {
    const { fts5Works } = await import('../src/local/db.ts');
    expect(fts5Works()).toBe(true);
  });
});
