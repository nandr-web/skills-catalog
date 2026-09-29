// Every test catalog lives in a fresh folder this run makes under the OS temp folder. The fail-safe (contract §8)
// refuses any folder under the real home (taken from the OS user record, not $HOME), and any folder that is not a
// direct child of the temp folder made by this run (on Linux the temp folder is /tmp itself, so /tmp can't be
// refused wholesale). Folders are removed after each test.

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach } from 'vitest';

const PREFIX = 'skills-catalog-test-';
const made: string[] = [];

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

export function refuseRealPlaces(path: string, home = userInfo().homedir, temp = tmpdir(), ours: readonly string[] = made): string {
  const p = real(path);
  const h = real(home);
  if (p === h || p.startsWith(h + sep)) throw new Error(`fail-safe: ${p} is under the real home ${h}; tests never write there`);
  const underOurs = ours.some((d) => p === d || p.startsWith(d + sep));
  const ourShape = dirname(p) === real(temp) && basename(p).startsWith(PREFIX);
  if (!underOurs && !ourShape) throw new Error(`fail-safe: ${p} is not a folder this test run made under ${real(temp)}`);
  return p;
}

export function sandbox(): string {
  const dir = real(mkdtempSync(join(tmpdir(), PREFIX)));
  refuseRealPlaces(dir);
  made.push(dir);
  return dir;
}

afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

// The QA goldens, read as they are, for the client's tests too.
export { loadGolden } from './golden.ts';
