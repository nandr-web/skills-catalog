// Copies the diagram renderer's bundle (built from the owner's own tools) into qa/src/map/renderer.js, so the map
// builds here on its own. Copied byte for byte: its first lines say what it is and which build it came from. Never
// edit the vendored file by hand: rebuild the bundle and vendor it again.
//
//   node scripts/vendor-renderer.ts <path to the bundle>

import { copyFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/vendor-renderer.ts <path to the bundle>');
  process.exit(1);
}
if (!readFileSync(source, 'utf8').startsWith("// A diagram renderer from the owner's own tools (build ")) {
  console.error(`${source} isn't the diagram renderer's bundle`);
  process.exit(1);
}
copyFileSync(source, join(import.meta.dirname, '..', 'src', 'map', 'renderer.js'));
