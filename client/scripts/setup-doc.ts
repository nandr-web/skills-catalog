// Writes docs/setup.md, the setup doc an assistant can follow (skill-setup-by-agent), from the words file and setup's
// question table (cli/setup.ts setupDoc). client/test/setup-command.test.ts fails when the checked-in page differs.
import { writeFileSync } from 'node:fs';
import { Words } from '@skills-catalog/core';
import { setupDoc } from '../src/cli/setup.ts';
import { cliWords } from '../src/cli/words.ts';

const page = new URL('../../docs/setup.md', import.meta.url);
writeFileSync(page, setupDoc(cliWords(Words.load())));
console.log(`wrote ${page.pathname}`);
