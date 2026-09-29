// Copies the agent-experience notes' surface.yaml (every word an assistant sees) into core/surface/surface.yaml.
// The data is copied as is; comments are left behind (the design notes explain the words, the product only
// renders them). Never edit the vendored file by hand: change the source and vendor it again.
//
//   node scripts/vendor-surface.ts <path to surface.yaml>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/vendor-surface.ts <path to surface.yaml>');
  process.exit(1);
}
const data = parse(readFileSync(source, 'utf8'));
const header =
  '# Every word an assistant sees from skills-catalog: tool names and descriptions, server instructions, result and\n' +
  '# error sentences, setup text and the companion skill. Vendored from the agent-experience notes by\n' +
  '# scripts/vendor-surface.ts; never edit by hand.\n';
writeFileSync(join(import.meta.dirname, '..', 'surface', 'surface.yaml'), header + stringify(data, { lineWidth: 0 }));
