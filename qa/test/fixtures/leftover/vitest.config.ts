// The canary's own run (test/temp-folders.test.ts): one test that leaves a child writing into its folder, under the same
// globalSetup as the suite, which must fail the run.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['leaky.fixture.ts'], globalSetup: ['../../temp-folders.ts'] } });
