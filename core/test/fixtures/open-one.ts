// One open of a catalog from its own process, for the "a fresh catalog opened at once" test: node open-one.ts
// <catalog dir> <start at ms>. Every process waits for the same start time, so the opens really overlap.

import { openLocalCatalog } from '../../src/local/index.ts';

const [dir, startAt] = process.argv.slice(2) as [string, string];
while (Date.now() < Number(startAt)) {
  // spin until the shared start
}
const catalog = await openLocalCatalog(dir);
catalog.close();
process.stdout.write('opened');
