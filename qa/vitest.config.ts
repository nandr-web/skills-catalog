// Two groups of test files: `slow`, the files listed in test/slow.json with their measured times (npm run test:slow),
// and `fast`, every other file (npm test, npm run check and the per-part test:* scripts). `npx vitest run` runs both,
// as the pre-flight and the mutation runs do.
import { existsSync, readFileSync } from 'node:fs';
import { configDefaults, defineConfig } from 'vitest/config';

const slow = (JSON.parse(readFileSync(new URL('./test/slow.json', import.meta.url), 'utf8')) as { files: { file: string }[] }).files.map((f) => f.file);
for (const f of slow) if (!existsSync(new URL(f, import.meta.url))) throw new Error(`test/slow.json lists ${f}, which doesn't exist`);

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'fast', exclude: [...configDefaults.exclude, ...slow] } },
      { extends: true, test: { name: 'slow', include: slow } },
    ],
  },
});
