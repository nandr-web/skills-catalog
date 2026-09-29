// The `qa` command line, run as a process (the parts the in-process tests don't reach: argument parsing, exit codes,
// signals), always on a fake machine (test/machine.ts).
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, machine, qaSpawn, qaSync, scratch, type TestMachine } from './machine.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
afterEach(cleanup);

/** A recorded trace for the fake assistant, with the spike's stand-in tool renamed to this surface's search tool. */
function trace(dir: string) {
  const t = join(dir, 'trace.jsonl');
  writeFileSync(t, readFileSync(here('../fixtures/traces/haiku-mcp-only-direct.jsonl'), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills'));
  return t;
}
const agent = (dir: string, extra: string[]) => ['agent', '--surface', `${here('./fixtures/surface.yaml')}#proposed`, '--mcp', `${process.execPath} -e ""`,
  '--claude', `${process.execPath} ${here('./fixtures/fake-claude.mjs')}`, '--tries', '1', '--out', join(dir, 'out'), '--no-preflight', ...extra];
const runsIn = (m: TestMachine) => (existsSync(sandboxBase(m.tmp)) ? readdirSync(sandboxBase(m.tmp)) : []);

describe('qa on the command line', () => {
  it('qa trace-check: exit 0 and a count line on the real goldens', () => {
    const r = qaSync(null, ['trace-check']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/requirement items, \d+ requirements, \d+ scenarios/);
    expect(r.stdout).toMatch(/trace-check: no issues/);
  });

  it('qa agent: its own flags parse, and a passing round exits 0 with the summary', () => {
    const m = machine(), dir = scratch('qa-cli-');
    const r = qaSync(m, agent(dir, ['--scenario', 'A1', '--setup', 'mcp']), { FAKE_CLAUDE_TRACE: trace(dir) });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/A1 +mcp +haiku +pass/);
  });

  it('qa agent without --surface or --mcp prints the usage and exits 1', () => {
    const m = machine();
    const r = qaSync(m, ['agent', '--scenario', 'A1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/qa agent --surface/);
  });

  it('qa agent: an unknown scenario or setup name is refused before anything runs (exit 1)', () => {
    const m = machine(), dir = scratch('qa-cli-');
    for (const extra of [['--scenario', 'A99'], ['--scenario', 'A1', '--setup', 'mcp-only']]) {
      const r = qaSync(m, agent(dir, extra), { FAKE_CLAUDE_TRACE: trace(dir) });
      expect(r.status, extra.join(' ')).toBe(1);
      expect(r.stderr).toMatch(/unknown (scenario|setup)/);
    }
    expect(runsIn(m)).toEqual([]);
  });

  it('qa agent: when nothing ran (every chosen scenario skipped), it says so and exits 1, never 0', () => {
    const m = machine(), dir = scratch('qa-cli-');
    const r = qaSync(m, agent(dir, ['--scenario', 'A4', '--setup', 'mcp']), { FAKE_CLAUDE_TRACE: trace(dir) });   // A4 needs slice 1's fixtures
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/nothing ran/);
  });

  it('qa agent: Ctrl-C stops the assistant\'s process group, tears the try down and exits 130', async () => {
    const m = machine(), dir = scratch('qa-cli-');
    const pidFile = join(dir, 'fake-claude.pid');
    const p = qaSpawn(m, agent(dir, ['--scenario', 'A1', '--setup', 'mcp']), { env: { FAKE_CLAUDE_TRACE: trace(dir), FAKE_CLAUDE_SLEEP_MS: '30000', FAKE_CLAUDE_PID: pidFile } });
    let err = '';
    p.stderr!.on('data', (b) => { err += b; });
    for (let i = 0; i < 200 && !existsSync(pidFile); i++) await new Promise((ok) => setTimeout(ok, 50));
    const fake = Number(readFileSync(pidFile, 'utf8'));
    p.kill('SIGINT');
    const code = await new Promise((ok) => p.on('exit', ok));
    expect(code, err).toBe(130);
    expect(() => process.kill(fake, 0)).toThrow();                                 // the assistant is gone
    expect(runsIn(m)).toEqual([]);                                                  // and so is its sandbox
    expect(err).toMatch(/interrupted/);
  });

  it('qa run and qa janitor refuse an unsafe base with exit 3 and delete nothing', () => {
    const m = machine();
    const r0 = qaSync(m, ['run', '--', 'true']);
    expect(r0.status, r0.stderr).toBe(0);
    chmodSync(sandboxBase(m.tmp), 0o755);
    for (const a of [['janitor'], ['run', '--', 'true']]) {
      const r = qaSync(m, a);
      expect(r.status, a.join(' ')).toBe(3);
      expect(r.stderr).toMatch(/chmod 700/);
    }
  });
});
