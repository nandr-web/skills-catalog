// The `qa` command line, run as a process (the parts the in-process tests don't reach: argument parsing, exit codes).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const CLI = here('../src/cli.ts');
const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const qa = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120_000 });

describe('qa on the command line', () => {
  it('qa trace-check: exit 0 and a count line on the real goldens', () => {
    const r = qa(['trace-check']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/requirement items, \d+ requirements, \d+ scenarios/);
    expect(r.stdout).toMatch(/trace-check: no issues/);
  });

  it('qa agent: its own flags parse, and a passing round exits 0 with the summary', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'qa-cli-')));
    made.push(dir);
    const trace = join(dir, 'trace.jsonl');
    writeFileSync(trace, readFileSync(here('../fixtures/traces/haiku-mcp-only-direct.jsonl'), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills'));
    const r = qa(['agent', '--surface', `${here('./fixtures/surface.yaml')}#proposed`, '--mcp', `${process.execPath} -e ""`,
      '--claude', `${process.execPath} ${here('./fixtures/fake-claude.mjs')}`, '--scenario', 'A1', '--setup', 'mcp', '--tries', '1',
      '--out', join(dir, 'out'), '--no-preflight'], { FAKE_CLAUDE_TRACE: trace });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/A1 +mcp +haiku +pass/);
  });

  it('qa agent without --surface or --mcp prints the usage and exits 1', () => {
    const r = qa(['agent', '--scenario', 'A1']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/qa agent --surface/);
  });
});
