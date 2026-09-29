// Which assistant binary a live run starts (the QA plan §3; traceability qa-clean-runs). Only by a full path: a bare
// `claude` runs whatever copy PATH finds first, and a copy macOS never approved shows the person its "downloaded from
// the Internet" prompt, even for --version. The default is Claude Code's own install place in the machine's home;
// every test here uses a fake machine and stubs of its own, and never starts a real assistant.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultAssistant, resolveAssistant } from '../src/agent/assistant.ts';
import { preflight } from '../src/agent/preflight.ts';
import { runScenarios } from '../src/agent/runner.ts';
import { UnsafeError } from '../src/safe-delete.ts';
import { cleanup, machine, qaSync, scratch } from './machine.ts';

vi.setConfig({ testTimeout: 30_000 });   // these tests start processes, each a few seconds on a busy machine

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FAKE = here('./fixtures/fake-claude.mjs');
const PATH0 = process.env.PATH;
afterEach(() => {
  cleanup();
  process.env.PATH = PATH0;
  for (const k of Object.keys(process.env)) if (k.startsWith('QA_FAKE_CLAUDE_')) delete process.env[k];
});

/** An executable stub at `path` that runs the fake assistant, and records in `marker` that it was started. */
function stub(path: string, marker: string) {
  writeFileSync(path, `#!/bin/sh\necho started >> '${marker}'\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(path, 0o755);
}
const quarantine = (path: string, flags: string) => spawnSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `${flags};00000000;qa-test;`, path]);

describe('the assistant is started only by its full path', () => {
  it('a bare name, a relative path, a missing file, a folder or a file that can\'t run: refused, nothing started', () => {
    const d = scratch();
    const plain = join(d, 'not-executable');
    writeFileSync(plain, '#!/bin/sh\n');
    for (const argv of [['claude'], ['./claude'], ['bin/claude'], [join(d, 'missing')], [d], [plain], []]) {
      expect(() => resolveAssistant(argv), JSON.stringify(argv)).toThrow(UnsafeError);
    }
  });

  it('a link is resolved to its real file (realpath), which is what runs and what is printed', () => {
    const d = scratch();
    const marker = join(d, 'started');
    stub(join(d, 'real-claude'), marker);
    symlinkSync(join(d, 'real-claude'), join(d, 'claude'));
    expect(resolveAssistant([join(d, 'claude'), '--flag'])).toEqual([join(d, 'real-claude'), '--flag']);
    expect(existsSync(marker)).toBe(false);   // resolving runs nothing
  });

  it.runIf(platform() === 'darwin')('a copy macOS never approved (quarantine flags without 0x40) is refused before it runs, even for --version; an approved one is fine', () => {
    const d = scratch();
    const marker = join(d, 'started');
    const bin = join(d, 'claude');
    stub(bin, marker);
    quarantine(bin, '0081');
    expect(() => resolveAssistant([bin])).toThrow(/quarantine/);
    quarantine(bin, '00c1');
    expect(resolveAssistant([bin])).toEqual([bin]);
    expect(existsSync(marker)).toBe(false);
  });

  it('the default is Claude Code\'s own place in the machine\'s home, never a name looked up on PATH', () => {
    const m = machine();
    expect(defaultAssistant(m)).toEqual([join(m.home, '.local', 'bin', 'claude')]);
  });
});

describe('the runner and the pre-flight', () => {
  const base = (m: ReturnType<typeof machine>) => ({
    scenariosFile: here('../golden/agent-scenarios.yaml'), queriesFile: here('../golden/queries.yaml'), phrasesFile: here('../golden/phrases.yaml'),
    surface: `${here('./fixtures/surface.yaml')}#proposed`, catalogCommand: [process.execPath, '-e', ''], cliCommand: [process.execPath, '-e', ''],
    models: ['claude-haiku-4-5-20251001'], tries: 1, out: join(m.dir, 'out'), machine: m, productRepo: null, scenarios: ['A1'], setups: ['mcp'],
  });
  function traceFor(dir: string) {
    const t = join(dir, 'trace.jsonl');
    writeFileSync(t, readFileSync(here('../fixtures/traces/haiku-mcp-only-direct.jsonl'), 'utf8').replaceAll('mcp__catalog__find_skills', 'mcp__skills-catalog__search_shared_skills'));
    return t;
  }

  it('a stub named claude first on PATH is never started: with no claude in the machine\'s home, the round is refused before any try', async () => {
    const m = machine();
    const bin = join(m.dir, 'path-bin');
    mkdirSync(bin);
    const marker = join(m.dir, 'path-claude-started');
    stub(join(bin, 'claude'), marker);
    process.env.PATH = `${bin}:${PATH0}`;
    process.env.QA_FAKE_CLAUDE_TRACE = traceFor(m.dir);
    await expect(runScenarios(base(m))).rejects.toThrow(UnsafeError);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(m.tmp, 'skills-catalog-qa')) ? readdirSync(join(m.tmp, 'skills-catalog-qa')) : []).toEqual([]);   // no try began
  });

  it('with no --claude, the round starts the machine\'s own ~/.local/bin/claude', async () => {
    const m = machine();
    const own = join(m.home, '.local', 'bin');
    mkdirSync(own, { recursive: true });
    const marker = join(m.dir, 'own-claude-started');
    stub(join(own, 'claude'), marker);
    process.env.QA_FAKE_CLAUDE_TRACE = traceFor(m.dir);
    const report = await runScenarios(base(m));
    expect(report.runs.map((r) => r.outcome)).toEqual(['pass']);
    expect(readFileSync(marker, 'utf8')).toBe('started\n');
  });

  const pre = (m: ReturnType<typeof machine>, claude: string[] | undefined, lines: string[]) => preflight({
    qaDir: here('..'), scenariosFile: here('../golden/agent-scenarios.yaml'), surfaceFile: here('./fixtures/surface.yaml'), variant: 'proposed',
    catalogCommand: [process.execPath, here('./fixtures/fake-mcp.mjs')], skipTests: true, skipLogin: true, machine: m, scenarios: ['A1'],
    ...(claude ? { claude } : {}), report: (l: string) => lines.push(l),
  });

  it('the pre-flight prints the resolved path and the version before the servers and the login probe', async () => {
    const m = machine();
    const lines: string[] = [];
    expect((await pre(m, [process.execPath, FAKE], lines)).filter((p) => p.startsWith('assistant:'))).toEqual([]);
    const node = realpathSync.native(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(lines).toContainEqual(expect.stringMatching(new RegExp(`^assistant: ${node} .*fake-claude\\.mjs \\(0\\.0\\.0 \\(fake claude\\)\\)$`)));
  });

  it('the pre-flight refuses a bare name or a missing default as a problem, and starts nothing', async () => {
    const m = machine();
    const bin = join(m.dir, 'path-bin');
    mkdirSync(bin);
    const marker = join(m.dir, 'path-claude-started');
    stub(join(bin, 'claude'), marker);
    process.env.PATH = `${bin}:${PATH0}`;
    for (const claude of [['claude'], undefined]) {
      const problems = await pre(m, claude, []);
      expect(problems, JSON.stringify(claude)).toContainEqual(expect.stringMatching(/^assistant: /));
    }
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(platform() === 'darwin')('the pre-flight refuses a quarantined copy, and starts nothing', async () => {
    const m = machine();
    const marker = join(m.dir, 'started');
    const bin = join(m.dir, 'claude');
    stub(bin, marker);
    quarantine(bin, '0081');
    expect(await pre(m, [bin], [])).toContainEqual(expect.stringMatching(/^assistant: .*quarantine/));
    expect(existsSync(marker)).toBe(false);
  });

  it('qa agent --claude with a bare name refuses to start (exit 3)', () => {
    const m = machine();
    const r = qaSync(m, ['agent', '--surface', `${here('./fixtures/surface.yaml')}#proposed`, '--mcp', `${process.execPath} -e ""`, '--claude', 'claude', '--no-preflight', '--scenario', 'A1', '--setup', 'mcp', '--out', join(m.dir, 'out')]);
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr).toMatch(/full path/);
  });
});
