// Every test file runs the core's run-wide fail-safe first (contract §8): whatever a test forgets to sandbox, nothing it
// writes lands under the real home or Claude Code's folders. The servers the tests start are separate processes, each
// given only sandbox places (test/server.ts checks them before it starts one).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { setupFiles: ['@skills-catalog/core/testing/fail-safe'] } });
