// Writes the published schemas (contract §1.1), docs/api/openapi.local.json and openapi.hosted.json, from the
// operations' definitions: `npm run schema`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openapiJson } from '../src/openapi.ts';

for (const where of ['local', 'hosted'] as const) {
  const file = fileURLToPath(new URL(`../../docs/api/openapi.${where}.json`, import.meta.url));
  mkdirSync(new URL('../../docs/api/', import.meta.url), { recursive: true });
  writeFileSync(file, openapiJson(where));
  console.log(`wrote ${file}`);
}
