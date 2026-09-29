// One open of a catalog from its own process, for the "a fresh catalog opened at once" test: node open-one.ts
// <catalog dir>. It prints "ready" once its imports are loaded, then waits for the start time the test sends every
// process on stdin, so the opens really overlap however long each process took to start.

import { openLocalCatalog } from '../../src/local/index.ts';
import { startTogether } from './together.ts';

const [dir] = process.argv.slice(2) as [string];
await startTogether();
const catalog = await openLocalCatalog(dir);
catalog.close();
process.stdout.write('opened');
