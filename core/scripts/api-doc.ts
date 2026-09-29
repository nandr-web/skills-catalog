// Writes the API page's reference section (docs/api.md, between its markers) from the operations' definitions:
// `npm run api-doc`.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { withReference } from '../src/api-doc.ts';

const file = fileURLToPath(new URL('../../docs/api.md', import.meta.url));
writeFileSync(file, withReference(readFileSync(file, 'utf8')));
console.log(`wrote ${file}`);
