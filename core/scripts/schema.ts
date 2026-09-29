// Writes the published schema (contract §1.1), docs/api/openapi.json, from the operations' definitions: `npm run schema`.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openapiJson } from '../src/openapi.ts';

const file = fileURLToPath(new URL('../../docs/api/openapi.json', import.meta.url));
writeFileSync(file, openapiJson());
console.log(`wrote ${file}`);
