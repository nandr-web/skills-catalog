// What `npm run config-modules` writes: the config tables (config/*.txt) as one module, src/skill-tree/config-data.ts,
// so the skill tree reads no file when it loads (a bundle has no config folder). The files stay the source.
import { join } from 'node:path';

const CONFIG = join(import.meta.dirname, '..', '..', 'config');
export const CONFIG_FILES = {
  RESERVED_NAMES_TEXT: join(CONFIG, 'reserved-names.txt'),
  INVISIBLE_CHARACTERS_TEXT: join(CONFIG, 'invisible-characters.txt'),
  CASE_FOLDING_TEXT: join(CONFIG, 'case-folding.txt'),
  EMOJI_PROPERTIES_TEXT: join(CONFIG, 'emoji-properties.txt'),
} as const;
export const CONFIG_DATA_FILE = join(import.meta.dirname, 'config-data.ts');

export function configModule(texts: Record<string, string>): string {
  const lines = ['// Written by `npm run config-modules` from config/*.txt; edit those files, never this one.', ''];
  for (const [name, text] of Object.entries(texts)) lines.push(`export const ${name} = ${JSON.stringify(text)};`, '');
  return lines.join('\n');
}
