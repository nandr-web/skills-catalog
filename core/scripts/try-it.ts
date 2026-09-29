// Try the catalog by hand: two developers, ana and bob, share one catalog.
//
//   npm run try-it        (from the core folder, after npm ci)
//
// It makes a new, empty catalog in a fresh folder under the OS temp folder, runs each step through the catalog's
// own operations, prints what an AI assistant would read back (the product's own words, marked │), shows what the
// catalog folder holds, and deletes the folder. It changes nothing else: not this repository, not your home folder.

import { mkdtempSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { CatalogError, Words, actAs, openLocalCatalog, randomIds, renderDiff, renderError, renderRead, renderSearch, renderVersions, type Catalog } from '../src/index.ts';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'skills-catalog-try-')));
if (dir.startsWith(realpathSync(homedir()) + sep)) {
  rmdirSync(dir); // still empty: nothing has been written to it
  throw new Error(`refusing ${dir}: it is under your home folder`);
}

const surface = Words.load();
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
const step = (who: string, what: string) => console.log(`\n${bold(`${++n}. ${who} ${what}`)}`);
const show = (text: string) => console.log(text.replace(/^/gm, '   │ '));
const refused = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    show('(it went through, which it should not have)');
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    show(renderError(surface, e));
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

  step('ana', 'publishes two skills');
  for (const [name, files] of [['release-note-draft', releaseNotesV1], ['sql-migrations', sqlMigrations]] as const) {
    const r = await catalog.publish({ name, files, message: 'first version' }, ana);
    show(`published ${r.name} v${r.version} as ${r.publisher}, fingerprint ${r.fingerprint.slice(0, 19)}…`);
  }

  const q1 = 'changelog for a release';
  step('bob', `searches "${q1}"`);
  show(renderSearch(surface, await catalog.search({ query: q1 }), { query: q1 }));

  step('bob', 'reads release-note-draft');
  show(renderRead(surface, await catalog.read({ name: 'release-note-draft' }), randomIds));

  step('ana', 'publishes version 2, which adds a script');
  const v2 = await catalog.publish({ name: 'release-note-draft', files: releaseNotesV2, message: 'add a script that lists merged PRs' }, ana);
  show(`published ${v2.name} v${v2.version}; risk flags: ${v2.risk_flags.map((f) => `${f.kind} (${f.path})`).join(', ') || 'none'}`);

  step('bob', 'looks at the history');
  show(renderVersions(surface, await catalog.versions({ name: 'release-note-draft' })));

  step('bob', 'compares version 1 with version 2');
  show(renderDiff(surface, await catalog.diff({ name: 'release-note-draft', from: 1, to: 2 }), randomIds));

  step('bob', 'tries to publish over release-note-draft (only ana, who published it first, may)');
  await refused(() => catalog.publish({ name: 'release-note-draft', files: releaseNotesV1 }, bob));

  const q2 = 'graphql schema';
  step('bob', `searches "${q2}" (nothing in the catalog is about GraphQL)`);
  show(renderSearch(surface, await catalog.search({ query: q2 }), { query: q2 }));

  step('bob', 'mistypes a name: relase-note-draft');
  await refused(() => catalog.read({ name: 'relase-note-draft' }));

  console.log(`\nThe catalog folder now holds ${contents(root)}.`);
} finally {
  opened?.close();
  rmSync(dir, { recursive: true, force: true });
  console.log(`Deleted ${dir}. Nothing else was changed.`);
}
