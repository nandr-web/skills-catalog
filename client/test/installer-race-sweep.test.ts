// The full swap sweeps (a slow file, test/slow.json): every interleaving up to the 64th check, past the 22 an install
// makes and the 30 of an update. installer-race.test.ts runs the same sweeps to a small bound in the fast suite.
import { describe, vi } from 'vitest';
import { sweeps } from './race.ts';

vi.mock('node:fs', async (original) => (await import('./race-fs.ts')).mockFs(await original()));

describe('links swapped in while the installer replaces a copy, every check (the security review\'s races)', () => {
  sweeps(64);
});
