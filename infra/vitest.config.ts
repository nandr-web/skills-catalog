// Synth runs in process (App → Template); no test deploys, looks anything up in an account or runs Docker.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 60_000,
  },
});
