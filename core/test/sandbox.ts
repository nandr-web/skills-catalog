// Every test catalog lives in a fresh folder under the OS temp folder, and the fail-safe refuses any folder under the
// real home (taken from the OS user record, not $HOME) or under /tmp (contract §8). Folders are removed after each test.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach } from 'vitest';

const FORBIDDEN = [userInfo().homedir, '/tmp', '/private/tmp'].map((p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
});

export function refuseRealPlaces(path: string): string {
  const real = realpathSync(path);
  for (const bad of FORBIDDEN) {
    if (real === bad || real.startsWith(bad + sep)) throw new Error(`fail-safe: ${real} is under ${bad}; tests never write there`);
  }
  return real;
}

const made: string[] = [];

export function sandbox(): string {
  const dir = refuseRealPlaces(mkdtempSync(join(tmpdir(), 'skills-catalog-test-')));
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});
