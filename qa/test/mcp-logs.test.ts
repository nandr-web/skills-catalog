// MCP servers' logs (the QA plan §3): a run whose assistant starts MCP servers also leaves a folder in Claude Code's
// cache, named after the working folder (<cache>/<slug>/mcp-logs-<server>/*.jsonl), each holding a server's error
// output. Teardown keeps each server's log with the try's transcript, then removes that folder, by its exact name and
// under the same safe-deletion rules as the other leftovers (§6.5a); the before/after check and the janitor watch the
// cache too. Every test here uses a fake machine.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runScenarios } from '../src/agent/runner.ts';
import { compare, snapshot, watchOn } from '../src/check.ts';
import { janitor } from '../src/janitor.ts';
import { leftoverNames, leftoverPaths, MCP_LOG_MAX_BYTES, slug } from '../src/leftovers.ts';
import { fakeMachine } from '../src/machine.ts';
import { realClaudeCache, realPlaces, removeLeftover } from '../src/safe-delete.ts';
import { createSandbox, newRunId, realHome, sandboxBase } from '../src/sandbox.ts';
import { teardown } from '../src/teardown.ts';
import { cleanup, machine, scratch, type TestMachine } from './machine.ts';

afterEach(() => { cleanup(); for (const k of Object.keys(process.env)) if (k.startsWith('QA_FAKE_CLAUDE_')) delete process.env[k]; });

const HOUR = 3600_000;
const LEFTOVERS = fileURLToPath(new URL('../src/leftovers.ts', import.meta.url));
const T0 = Date.parse('2026-09-28T10:00:00Z');
const run = (m: TestMachine, at = T0) => createSandbox({ runId: newRunId(new Date(at)), machine: m, now: () => at });
/** The cache folder Claude Code makes for an assistant working in the run's work folder. */
const cacheOf = (m: TestMachine, root: string) => join(m.roots.claudeCache, slug(join(root, 'work')));
function serverLog(m: TestMachine, root: string, server: string, text = `${server}: started\n`) {
  const dir = join(cacheOf(m, root), `mcp-logs-${server}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-09-29T01-00-00-000Z.jsonl'), text);
  return dir;
}

describe('where Claude Code\'s cache is', () => {
  it('a fake machine has one, made empty; the real one is where Claude Code keeps it', () => {
    const dir = scratch();
    const m = fakeMachine(dir);
    expect(m.roots.claudeCache).toBe(join(dir, 'cache', 'claude-cli-nodejs'));
    expect(readdirSync(m.roots.claudeCache)).toEqual([]);
    expect(realClaudeCache()).toBe(platform() === 'darwin' ? join(realHome(), 'Library', 'Caches', 'claude-cli-nodejs') : join(realHome(), '.cache', 'claude-cli-nodejs'));
  });

  it('the real cache is one of the places a test process never touches, and the tripwire refuses it before looking', () => {
    expect(realPlaces()).toContain(realClaudeCache());
    expect(() => removeLeftover(realClaudeCache(), 'qa-tripwire-never-exists')).toThrow(/tripwire/);
  });

  it('a run\'s exact leftover names include its cache folders, never a pattern', () => {
    const m = machine();
    const sb = run(m);
    const paths = leftoverPaths(sb.root, m);
    for (const n of leftoverNames(sb.root)) expect(paths).toContain(join(m.roots.claudeCache, n));
    expect(paths).toContain(cacheOf(m, sb.root));
  });
});

describe('teardown and the servers\' logs', () => {
  it('keeps each server\'s log with the try\'s transcript, then removes the run\'s cache folder', async () => {
    const m = machine();
    const sb = run(m);
    serverLog(m, sb.root, 'skills-catalog', '{"error":"the catalog could not open"}\n');
    serverLog(m, sb.root, 'qa-person');
    const keep = join(m.dir, 'out', 'traces', 'A1-mcp-haiku-1.mcp-logs');
    const r = await teardown(sb, { machine: m, keepLogsIn: keep });
    expect(readFileSync(join(keep, 'mcp-logs-skills-catalog', '2026-09-29T01-00-00-000Z.jsonl'), 'utf8')).toBe('{"error":"the catalog could not open"}\n');
    expect(readFileSync(join(keep, 'mcp-logs-qa-person', '2026-09-29T01-00-00-000Z.jsonl'), 'utf8')).toBe('qa-person: started\n');
    expect(existsSync(cacheOf(m, sb.root))).toBe(false);
    expect(r.removed).toContain(cacheOf(m, sb.root));
    expect(r.kept?.sort()).toEqual([join(keep, 'mcp-logs-qa-person', '2026-09-29T01-00-00-000Z.jsonl'), join(keep, 'mcp-logs-skills-catalog', '2026-09-29T01-00-00-000Z.jsonl')]);
  });

  it('never follows a link: a linked log or log folder isn\'t copied, its target is kept, and the links go', async () => {
    const m = machine();
    const sb = run(m);
    const canary = scratch('qa-canary-');
    writeFileSync(join(canary, 'secret.txt'), 'canary\n');
    const logs = serverLog(m, sb.root, 'skills-catalog');
    symlinkSync(join(canary, 'secret.txt'), join(logs, 'linked.jsonl'));
    symlinkSync(canary, join(cacheOf(m, sb.root), 'mcp-logs-evil'));
    const keep = join(m.dir, 'kept');
    const r = await teardown(sb, { machine: m, keepLogsIn: keep });
    expect(readdirSync(join(keep, 'mcp-logs-skills-catalog'))).toEqual(['2026-09-29T01-00-00-000Z.jsonl']);
    expect(existsSync(join(keep, 'mcp-logs-evil'))).toBe(false);
    expect(readFileSync(join(canary, 'secret.txt'), 'utf8')).toBe('canary\n');
    expect(existsSync(cacheOf(m, sb.root))).toBe(false);
    expect(r.skipped.map((s) => s.path).sort()).toEqual([join(cacheOf(m, sb.root), 'mcp-logs-evil'), join(logs, 'linked.jsonl')].sort());
  });

  // The assistant under test can write in that cache folder: whatever it puts there is read without waiting and only
  // up to a size.
  it('a pipe named like a log never stalls teardown: it isn\'t copied, and the folder still goes', { timeout: 30_000 }, async () => {
    const m = machine();
    const sb = run(m);
    const logs = serverLog(m, sb.root, 'skills-catalog');
    spawnSync('mkfifo', [join(logs, 'stuck.jsonl')]);
    const keep = join(m.dir, 'kept');
    // Kept in a child process with a time limit: were the open ever to wait on the pipe again, this fails in seconds
    // instead of hanging the test's own worker (which no test timeout can interrupt).
    const script = `import { keepMcpLogs } from ${JSON.stringify(LEFTOVERS)}; const [root, machine, dest] = JSON.parse(process.argv[1]); console.log(JSON.stringify(keepMcpLogs(root, machine, dest, new Set())));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([sb.root, m, keep])], { encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL' });
    expect(r.signal, 'keeping the logs waited on the pipe and was stopped after 10 s').toBeNull();
    expect(r.status, r.stderr).toBe(0);
    const kept = JSON.parse(r.stdout) as { kept: string[]; skipped: { path: string }[] };
    expect(kept.kept).toEqual([join(keep, 'mcp-logs-skills-catalog', '2026-09-29T01-00-00-000Z.jsonl')]);
    expect(kept.skipped.map((x) => x.path)).toEqual([join(logs, 'stuck.jsonl')]);
    await teardown(sb, { machine: m });
    expect(existsSync(cacheOf(m, sb.root))).toBe(false);
  });

  it(`a log over ${MCP_LOG_MAX_BYTES} bytes is kept up to that size, with a line saying it was cut`, async () => {
    const m = machine();
    const sb = run(m);
    serverLog(m, sb.root, 'skills-catalog', 'x'.repeat(MCP_LOG_MAX_BYTES + 10));
    const keep = join(m.dir, 'kept');
    await teardown(sb, { machine: m, keepLogsIn: keep });
    const kept = readFileSync(join(keep, 'mcp-logs-skills-catalog', '2026-09-29T01-00-00-000Z.jsonl'), 'utf8');
    expect(kept).toBe('x'.repeat(MCP_LOG_MAX_BYTES) + `\n[qa: cut here; the log was ${MCP_LOG_MAX_BYTES + 10} bytes]\n`);
  });

  it('with nowhere to keep the logs (a plain qa run), the folder is still removed', async () => {
    const m = machine();
    const sb = run(m);
    serverLog(m, sb.root, 'skills-catalog');
    await teardown(sb, { machine: m });
    expect(existsSync(cacheOf(m, sb.root))).toBe(false);
  });

  it('a cache folder that existed before the run is never deleted, nor copied', async () => {
    const m = machine();
    const runId = newRunId(new Date(T0));
    const root = join(sandboxBase(m.tmp), runId);
    const before = serverLog(m, root, 'skills-catalog', 'from before\n');
    const sb = createSandbox({ runId, machine: m, now: () => T0 });
    const keep = join(m.dir, 'kept');
    const r = await teardown(sb, { machine: m, keepLogsIn: keep });
    expect(readFileSync(join(before, '2026-09-29T01-00-00-000Z.jsonl'), 'utf8')).toBe('from before\n');
    expect(existsSync(keep)).toBe(false);
    expect(r.skipped).toContainEqual({ path: cacheOf(m, root), why: expect.stringMatching(/existed before the run/) });
  });

  it('a cache folder whose name differs only by a prefix is left alone (nothing is globbed)', async () => {
    const m = machine();
    const sb = run(m);
    const near = cacheOf(m, sb.root) + '-sub';
    mkdirSync(join(near, 'mcp-logs-x'), { recursive: true });
    await teardown(sb, { machine: m, keepLogsIn: join(m.dir, 'kept') });
    expect(existsSync(near)).toBe(true);
    expect(existsSync(join(m.dir, 'kept'))).toBe(false);
  });
});

describe('the before/after check and the janitor watch the cache', () => {
  it('a cache folder named after the sandbox, left behind, is a difference', () => {
    const m = machine();
    const sb = run(m);
    const w = watchOn(m, { sandboxRoot: sb.root });
    const before = snapshot(w);
    serverLog(m, sb.root, 'skills-catalog');
    const diff = compare(before, snapshot(w));
    expect(diff.map((d) => d.what)).toContain(`added folder ${cacheOf(m, sb.root)}`);
  });

  it('the janitor removes a finished run\'s cache folder with it, and reports one whose run folder is gone', () => {
    const m = machine();
    const old = run(m);
    const f = join(old.root, 'run.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), pid: spawnSync('true').pid }));   // its qa process has exited
    serverLog(m, old.root, 'skills-catalog');
    const orphan = join(m.roots.claudeCache, slug(sandboxBase(m.tmp)) + '-20260101T000000Z-deadbeef-work');
    mkdirSync(orphan);
    const r = janitor({ machine: m, now: () => T0 + 2 * HOUR });
    expect(r.removed).toContain(cacheOf(m, old.root));
    expect(existsSync(cacheOf(m, old.root))).toBe(false);
    expect(existsSync(orphan)).toBe(true);
    expect(r.skipped).toContainEqual({ path: orphan, why: expect.stringMatching(/run folder is gone/) });
  });
});

describe('the agent runner, end to end (fake claude)', () => {
  const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
  it('each try\'s MCP logs are kept beside its transcript, and the cache is left as it was', async () => {
    const m = { ...machine(), out: '' };
    m.out = join(m.dir, 'out');
    const trace = join(m.dir, 'trace.jsonl');
    writeFileSync(trace, readFileSync(here('../fixtures/traces/haiku-mcp-only-direct.jsonl'), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills'));
    process.env.QA_FAKE_CLAUDE_TRACE = trace;
    process.env.QA_FAKE_CLAUDE_MCP_LOGS = m.roots.claudeCache;
    const report = await runScenarios({
      scenariosFile: here('../golden/agent-scenarios.yaml'), queriesFile: here('../golden/queries.yaml'), phrasesFile: here('../golden/phrases.yaml'),
      surface: `${here('./fixtures/surface.yaml')}#proposed`, catalogCommand: [process.execPath, '-e', ''], cliCommand: [process.execPath, '-e', ''],
      claude: [process.execPath, here('./fixtures/fake-claude.mjs')], models: ['claude-haiku-4-5-20251001'], tries: 1, out: m.out, machine: m, productRepo: null,
      scenarios: ['A1'], setups: ['mcp'],
    });
    const [r] = report.runs;
    expect(r!.outcome).toBe('pass');
    expect(r!.differences).toEqual([]);
    const kept = r!.trace.replace(/\.jsonl$/, '.mcp-logs');
    expect(readdirSync(kept).sort()).toEqual(['mcp-logs-qa-person', 'mcp-logs-skills-catalog']);
    expect(readFileSync(join(kept, 'mcp-logs-skills-catalog', '2026-09-29T01-00-00-000Z.jsonl'), 'utf8')).toContain('skills-catalog: server started');
    expect(readdirSync(m.roots.claudeCache)).toEqual([]);
  }, 30_000);
});
