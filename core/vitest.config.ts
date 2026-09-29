import { readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

// Two groups of test files: `slow`, the files listed in test/slow.json with their measured times (npm run test:slow),
// and `fast`, every other file (npm test, npm run check and the per-part test:* scripts). `npx vitest run` runs both.
const slow = (JSON.parse(readFileSync(new URL('./test/slow.json', import.meta.url), 'utf8')) as { files: { file: string }[] }).files.map((f) => f.file);

export default defineConfig({
  test: {
    // Every test file starts behind the run-wide fail-safe (contract §8).
    setupFiles: ['./test/fail-safe.ts'],
    // node:sqlite is still marked experimental; only that one warning class is silenced.
    execArgv: ['--disable-warning=ExperimentalWarning'],
    projects: [
      { extends: true, test: { name: 'fast', exclude: [...configDefaults.exclude, ...slow] } },
      { extends: true, test: { name: 'slow', include: slow } },
    ],
  },
});
