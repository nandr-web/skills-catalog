// Try the catalog by hand: two developers, ana and bob, share one catalog.
//
//   npm run try-it        (from the core folder, after npm ci)
//
// It makes a new, empty catalog in a fresh folder under the OS temp folder, runs each step through the catalog's
// own operations, prints what an AI assistant would read back (the product's own words, marked │), shows what the
// catalog folder holds, and deletes the folder. It changes nothing else: not this repository, not your home folder.
// Each scene is tagged with the PRD item it shows ([FR-01], [UC-02 nothing matches], …), in the PRD's order; lines
// marked ✓ are this script's own checks (test/try-it.test.ts checks every scene, README.md's copy is checked too).

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { CatalogError, Words, actAs, inlineFiles, openLocalCatalog, randomIds, renderDiff, renderError, renderRead, renderSearch, renderVersions, type Catalog } from '../src/index.ts';
import { fingerprint, type Mode } from '../src/skill-tree/index.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skills-catalog-try-')));
if (dir.startsWith(realpathSync(homedir()) + sep)) {
  rmdirSync(dir); // still empty: nothing has been written to it
  throw new Error(`refusing ${dir}: it is under your home folder`);
}

const words = Words.load();
const ana = actAs('ana');
const bob = actAs('bob');
type File = { path: string; mode: string; content_base64: string };
const file = (path: string, text: string, mode = '0644'): File => ({ path, mode, content_base64: Buffer.from(text).toString('base64') });

const releaseNotesV1 = [
  file('SKILL.md', `---
name: release-note-draft
description: Write release notes and a changelog from the merged pull requests of a sprint. Use when asked to summarise changes for a release.
metadata:
  tags: release, docs
---
List the merged pull requests since the last tag, group them by area, and fill template.md.
`),
  file('template.md', '## What changed\n\n## Fixes\n\n## Thanks\n'),
];
const releaseNotesV2 = [
  ...releaseNotesV1,
  file('scripts/collect.sh', '#!/bin/sh\ngit log --merges --oneline "$(git describe --tags --abbrev=0)"..HEAD\n', '0755'),
];
// Malformed on purpose: a SKILL.md with no description (FR-01's exception), and a version 3 with no instructions under
// its front matter (UC-04's exception).
const noDescription = [file('SKILL.md', '---\nname: standup-notes\n---\nSummarise yesterday, today and blockers.\n')];
const releaseNotesNoBody = [file('SKILL.md', '---\nname: release-note-draft\ndescription: Write release notes.\n---\n'), releaseNotesV1[1]!];
const sqlMigrations = [
  file('SKILL.md', `---
name: sql-migrations
description: Write safe SQL schema migrations with a rollback step. Use when changing database tables.
---
Write the up and down steps, and test the rollback on a copy first.
`),
];

let n = 0;
// Bold only in a terminal, so piped or saved output stays plain text.
const bold = (s: string) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const step = (who: string, what: string, prd: string) => console.log(`\n${bold(`${++n}. ${who} ${what}`)}  [${prd}]`);
const show = (text: string) => console.log(text.replace(/^/gm, '   │ '));
const short = (fp: string) => `${fp.slice(0, 19)}…`;
// `folder`: the skill's folder, as publishing a folder through the assistant names it (the client adds it to a refusal
// about the folder's content, so the sentence can say where to fix it).
const refused = async (fn: () => Promise<unknown>, folder?: string) => {
  try {
    await fn();
    show('(it went through, which it should not have)');
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    show(renderError(words, folder ? new CatalogError(e.code, { ...e.data, folder }) : e));
  }
};

// What the catalog folder holds: the database, and each file's bytes stored once, by content.
function contents(root: string): string {
  const walk = (d: string): string[] => readdirSync(d).flatMap((e) => (statSync(join(d, e)).isDirectory() ? walk(join(d, e)) : [join(d, e)]));
  const all = walk(root);
  const db = all.filter((f) => f.includes('catalog.sqlite')).reduce((sum, f) => sum + statSync(f).size, 0);
  const blobs = all.filter((f) => f.startsWith(join(root, 'blobs') + sep)).length;
  return `a database (catalog.sqlite, ${Math.round(db / 1024)} KB) and ${blobs} stored files (blobs/)`;
}

const root = join(dir, 'catalog');
let opened: Catalog | undefined;
try {
  // Opened inside the try, so the folder is deleted even if opening fails.
  const catalog = await openLocalCatalog(root);
  opened = catalog;
  console.log(`Made a new, empty catalog in ${root}`);
  console.log('Lines marked │ are what an AI assistant, such as Claude, would read back: the product\'s own words.');
  console.log('Lines marked ✓ are this script\'s own checks. Each scene ends with the PRD item it shows, in [ ].');

  step('ana', 'publishes two skills', 'FR-01');
  const published: Record<string, string> = {};
  for (const [name, files] of [['release-note-draft', releaseNotesV1], ['sql-migrations', sqlMigrations]] as const) {
    const r = await catalog.publish({ name, files, message: 'first version' }, ana);
    published[name] = r.fingerprint;
    show(`published ${r.name} v${r.version} as ${r.publisher}, fingerprint ${short(r.fingerprint)}`);
  }

  step('ana', 'publishes a skill whose SKILL.md has no description', 'UC-01 rejected');
  await refused(() => catalog.publish({ name: 'standup-notes', files: noDescription }, ana), './standup-notes');
  await refused(() => catalog.versions({ name: 'standup-notes' }));

  const q1 = 'changelog for a release';
  step('bob', `searches "${q1}"`, 'FR-02');
  show(renderSearch(words, await catalog.search({ query: q1 }), { query: q1 }));

  const q2 = 'sourdough bread';
  step('bob', `searches "${q2}" (nothing in the catalog is about baking)`, 'UC-02 nothing matches');
  show(renderSearch(words, await catalog.search({ query: q2 }), { query: q2 }));

  const q3 = 'graphql schema';
  step('bob', `searches "${q3}" (nothing in the catalog is about GraphQL)`, 'UC-02 only close');
  show(renderSearch(words, await catalog.search({ query: q3 }), { query: q3 }));

  step('bob', 'reads release-note-draft', 'FR-03');
  show(renderRead(words, await catalog.read({ name: 'release-note-draft' }), randomIds));

  // The consistency NFR's measurement: publish, then retrieve, then compare against the original.
  step('bob', 'fetches version 1 and compares it with what ana published', 'NFR consistency');
  const fetched = await catalog.fetch({ name: 'release-note-draft', version: 1 });
  const got = new Map(inlineFiles(fetched).map((f) => [f.path, f]));
  const same = releaseNotesV1.every((f) => got.get(f.path)?.content_base64 === f.content_base64 && got.get(f.path)?.mode === f.mode) && got.size === releaseNotesV1.length;
  const sha = (b64: string) => createHash('sha256').update(Buffer.from(b64, 'base64')).digest('hex');
  const ours = fingerprint(releaseNotesV1.map((f) => ({ path: f.path, mode: f.mode as Mode, sha256: sha(f.content_base64) })));
  const fps = [published['release-note-draft']!, fetched.fingerprint, ours];
  console.log(same ? `   ✓ the same ${got.size} files, byte for byte: ${[...got.keys()].join(', ')}` : '   ✗ the files differ from what was published');
  console.log(`   ${new Set(fps).size === 1 ? '✓ the same' : '✗ a different'} fingerprint: ${short(fps[0]!)} published, ${short(fps[1]!)} fetched, ${short(fps[2]!)} worked out here from ana's files`);

  step('bob', 'mistypes a name: relase-note-draft', 'UC-03 not found');
  await refused(() => catalog.read({ name: 'relase-note-draft' }));

  step('ana', 'publishes version 2, which adds a script', 'FR-04');
  const v2 = await catalog.publish({ name: 'release-note-draft', files: releaseNotesV2, message: 'add a script that lists merged PRs' }, ana);
  show(`published ${v2.name} v${v2.version}; risk flags: ${v2.risk_flags.map((f) => `${f.kind} (${f.path})`).join(', ') || 'none'}`);

  step('ana', 'publishes a version 3 whose SKILL.md has no instructions', 'UC-04 malformed update');
  await refused(() => catalog.publish({ name: 'release-note-draft', files: releaseNotesNoBody }, ana), './release-note-draft');
  const after = await catalog.versions({ name: 'release-note-draft' });
  const kept = after.latest === 2 && after.versions.map((v) => v.fingerprint).join() === [v2.fingerprint, published['release-note-draft']].join();
  console.log(kept ? `   ✓ still ${after.versions.length} versions, latest v${after.latest}, each as it was: nothing of version 3 was stored` : '   ✗ the versions changed');

  step('bob', 'looks at the history', 'FR-04 history');
  show(renderVersions(words, await catalog.versions({ name: 'release-note-draft' })));

  step('bob', 'reads version 1, though version 2 is the latest', 'FR-04 earlier version');
  show(renderRead(words, await catalog.read({ name: 'release-note-draft', version: 1 }), randomIds));

  step('bob', 'compares version 1 with version 2', 'FR-04 change visible');
  show(renderDiff(words, await catalog.diff({ name: 'release-note-draft', from: 1, to: 2 }), randomIds));

  step('bob', 'tries to publish over release-note-draft (only ana, who published it first, may)', 'beyond the PRD');
  await refused(() => catalog.publish({ name: 'release-note-draft', files: releaseNotesV1 }, bob));

  console.log(`\nThe catalog folder now holds ${contents(root)}.`);
} finally {
  opened?.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`Deleted ${dir}. Nothing else was changed.`);
}
