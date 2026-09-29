// The stack's code: the hosted package's three function handlers, each re-exported by an entry here (src/entries) so
// this package's own esbuild bundles it from this folder (its lockfile the project root's); esbuild follows each import
// into the hosted package and resolves it from there, as its tests do. Core's words file goes beside the API's bundle.

import { fileURLToPath } from 'node:url';
import type { CodeEntries } from './constructs/function.ts';

const at = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));

export const CATALOG_CODE: CodeEntries = {
  api: at('src/entries/api.ts'),
  indexer: at('src/entries/indexer.ts'),
  sweep: at('src/entries/sweep.ts'),
  projectRoot: at(''),
  lockFile: at('package-lock.json'),
  words: at('../core/words/words.yaml'),
};
