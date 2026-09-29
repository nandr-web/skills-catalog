// Every test file runs the core's run-wide fail-safe first (contract §8). The emulator the tests start listens on
// 127.0.0.1 only and is stopped after each file (test/emulator.ts).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['@skills-catalog/core/testing/fail-safe'],
  },
});
