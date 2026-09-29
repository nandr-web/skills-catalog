// Writes src/skill-tree/config-data.ts from config/*.txt: `npm run config-modules`.
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_DATA_FILE, CONFIG_FILES, configModule } from '../src/skill-tree/config-module.ts';

writeFileSync(CONFIG_DATA_FILE, configModule(Object.fromEntries(Object.entries(CONFIG_FILES).map(([k, f]) => [k, readFileSync(f, 'utf8')]))));
console.log(`wrote ${CONFIG_DATA_FILE}`);
