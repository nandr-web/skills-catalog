import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every test file starts behind the run-wide fail-safe (contract §8).
    setupFiles: ['./test/fail-safe.ts'],
    // node:sqlite is still marked experimental; only that one warning class is silenced.
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
