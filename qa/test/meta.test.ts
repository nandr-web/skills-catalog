// Static guards on the QA tools' own code (qa-plan §6.5a, "Tests never reach real roots"): the real machine is chosen in
// one place, the command line; only the shared helper starts the command line in tests, always with a fake machine; and
// only one module deletes anything.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(d, e.name)) : /\.(ts|mjs|ya?ml|jsonl)$/.test(e.name) ? [join(d, e.name)] : []));
const src = files(dir('../src')), tests = files(dir('.'));
const rel = (f: string) => f.slice(dir('..').length);
const using = (list: string[], re: RegExp) => list.filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel).sort();

describe('the QA tools\' own guards', () => {
  it('only the command line asks for the real machine (every library function takes one explicitly)', () => {
    expect(using(src, /realMachine\(\)/)).toEqual(['src/cli.ts', 'src/machine.ts']);
    expect(using(src, /\btmpdir\(\)/)).toEqual(['src/machine.ts', 'src/safe-delete.ts', 'src/trace-check.ts']);   // trace-check: its own scratch folder only
  });

  it('only src/safe-delete.ts deletes (plus trace-check\'s own scratch folder)', () => {
    expect(using(src, /\b(rmSync|unlinkSync|rmdirSync)\b/)).toEqual(['src/safe-delete.ts', 'src/trace-check.ts']);
  });

  it('only test/machine.ts starts the qa command line (and the live script run by hand)', () => {
    expect(using(tests.filter((f) => !f.endsWith('meta.test.ts')), /src\/cli\.ts/)).toEqual(['test/live/qa-run-real.ts', 'test/machine.ts']);
  });

  it('the real-machine helpers are used only behind QA_LIVE', () => {
    const users = using(tests, /(qa|node)OnRealMachineSync\(/).filter((f) => f !== 'test/machine.ts' && f !== 'test/meta.test.ts');
    expect(users).toEqual(['test/agent-live.test.ts']);
    for (const f of users) expect(readFileSync(dir(`../${f}`), 'utf8'), f).toMatch(/skipIf\(!LIVE/);
  });


  it('only the live scripts, run by those helpers in a child process, use the real machine outside src/', () => {
    // safe-delete.test.ts only checks that it refuses in a test process
    expect(using(tests.filter((f) => !f.endsWith('meta.test.ts')), /realMachine\(\)/)).toEqual(['test/live/person-check.ts', 'test/safe-delete.test.ts']);
  });
});
