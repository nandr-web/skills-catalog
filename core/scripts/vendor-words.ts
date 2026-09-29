// Copies the agent-experience notes' words.yaml (every word an assistant sees) into core/words/words.yaml.
// The data is copied as is; comments are left behind (the design notes explain the words, the product only
// renders them). Never edit the vendored file by hand: change the source and vendor it again.
//
//   node scripts/vendor-words.ts <path to words.yaml>

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

const source = process.argv[2];
if (!source) {
  console.error('usage: node scripts/vendor-words.ts <path to words.yaml>');
  process.exit(1);
}
const data = parse(readFileSync(source, 'utf8'));
const header =
  '# Every word an assistant sees from skills-catalog: tool names and descriptions, server instructions, result and\n' +
  '# error sentences, setup text and the companion skill. Vendored from the agent-experience notes by\n' +
  '# scripts/vendor-words.ts; never edit by hand.\n';
// Written as YAML 1.1 so words like yes and no are quoted: any YAML reader, old or new, reads them as text.
writeFileSync(join(import.meta.dirname, '..', 'words', 'words.yaml'), header + stringify(data, { lineWidth: 0, version: '1.1' }));
