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
    expect(using(src, /realMachine\(\)/)).toEqual(['src/machine.ts']);   // machineFor, for the command line only
    expect(using(src, /\bmachineFor\(/)).toEqual(['src/cli.ts', 'src/machine.ts']);
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


  it('only src/demo/tmux.ts starts tmux, every server call on the demo\'s own socket with no config; the pane programs start only the catalog\'s own', () => {
    // a PATH can't keep tmux from the panes (on Linux /usr/bin/tmux is on theirs): the demo's code is what never calls it
    expect(using(src, /spawn(Sync)?\(\s*(BIN|bin|'tmux'|"tmux")\b/)).toEqual(['src/demo/tmux.ts']);
    const tmux = readFileSync(dir('../src/demo/tmux.ts'), 'utf8');
    expect(tmux).toContain("const BASE = ['-S', SOCKET, '-f', '/dev/null', '-u'];");
    const calls = [...tmux.matchAll(/\bspawn(?:Sync)?\(\s*(\w+),\s*\[([^\]]*)\]/g)];
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const [call, bin, args] of calls) {
      if (bin === 'bin') expect(args, call).toBe("'-V'");   // the version check, which starts no server
      else expect(`${bin} ${args}`, call).toMatch(/^BIN \.\.\.BASE\b/);
    }
    const panes = src.filter((f) => /src\/demo\/(assistant|steps-view)\.ts$/.test(f));
    expect(panes.map(rel).sort()).toEqual(['src/demo/assistant.ts', 'src/demo/steps-view.ts']);
    // the steps view starts nothing; a stand-in starts only the catalog's own programs, by the command the demo gives it
    // (DEMO_MCP): its MCP server (through the MCP client) and its command line
    expect(using(panes.filter((f) => f.endsWith('steps-view.ts')), /child_process/)).toEqual([]);
    const standIn = readFileSync(dir('../src/demo/assistant.ts'), 'utf8');
    expect(standIn).not.toMatch(/(?<![.\w])(exec|execSync|execFile|execFileSync|fork|spawnSync)\(/);   // a RegExp's .exec is no process
    for (const [call] of standIn.matchAll(/\bspawn\([^,]*,/g)) expect(call).toBe('spawn(cli[0]!,');
    expect([...standIn.matchAll(/\bconnect\(([^,]*),/g)].map((m) => m[1])).toEqual(['o.command']);
  });

  it('only the live scripts, run by those helpers in a child process, use the real machine outside src/', () => {
    // safe-delete.test.ts only checks that it refuses in a test process
    expect(using(tests.filter((f) => !f.endsWith('meta.test.ts')), /realMachine\(\)/)).toEqual(['test/live/person-check.ts', 'test/safe-delete.test.ts']);
  });
});
