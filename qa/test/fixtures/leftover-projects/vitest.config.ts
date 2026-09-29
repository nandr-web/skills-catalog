// A run shaped like the suite's own (vitest.config.ts: two projects, the check set on each), where each project leaves a
// folder (test/temp-folders.test.ts): one check must fail the run and name both.
import { defineConfig } from 'vitest/config';

const TEMP_FOLDERS = '../../temp-folders.ts';

export default defineConfig({
  test: {
    projects: [
      { extends: true, test: { name: 'a', include: ['leak.fixture.ts'], globalSetup: [TEMP_FOLDERS] } },
      { extends: true, test: { name: 'b', include: ['leak.fixture.ts'], globalSetup: [TEMP_FOLDERS] } },
    ],
  },
});
