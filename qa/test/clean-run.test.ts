// `qa run`'s clean-run machinery (qa-plan §6; brief §1): sandbox, fail-safe, teardown, before/after check. Every test works
// on a fake machine of its own (test/machine.ts). Safe deletion's canaries and the janitor are in safe-delete.test.ts.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { leftoverNames, slug } from '../src/leftovers.ts';
import { createSandbox, DIRS, FailSafeError, failSafe, newRunId, realHome } from '../src/sandbox.ts';
import { teardown } from '../src/teardown.ts';
import { compare, PRODUCT_DEFAULTS, runProcesses, snapshot, watchOn, type Watch } from '../src/check.ts';
import { cleanup, PROCESS_TEST_MS, machine as fakeMachine, scratch, type TestMachine } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

afterEach(cleanup);

/** A fake machine, and the before/after check's watch on it for one sandbox. */
function machine() {
  const m = fakeMachine();
  const watch = (sb: { root: string; runId?: string }, sessions: string[] = []): Watch => watchOn(m, { sandboxRoot: sb.root, runId: sb.runId, sessions });
  return { ...m, claudeTmp: m.roots.claudeTmp, watch };
}
const sandbox = (m: TestMachine) => createSandbox({ runId: newRunId(), machine: m });
const UUID1 = '00000000-0000-4000-8000-000000000001';

describe('sandbox', () => {
  it('[1] makes the run folders and exports the SKILLS_* settings pointing into them', () => {
    const m = machine();
    const sb = sandbox(m);
    expect(sb.root).toBe(join(m.tmp, 'skills-catalog-qa', sb.runId));
    for (const d of DIRS) expect(existsSync(join(sb.root, d)), d).toBe(true);
    expect(DIRS).toEqual(['catalog', 'home', 'install', 'assistant', 'work', 'outside', 'bin']);
    expect(sb.env).toMatchObject({
      SKILLS_CATALOG: `file://${join(sb.root, 'catalog')}`,
      SKILLS_HOME: join(sb.root, 'home'),
      SKILLS_INSTALL_DIR: join(sb.root, 'install'),
      SKILLS_ASSISTANT_HOME: join(sb.root, 'assistant'),
      SKILLS_SYNC_ON_START: '0',
      SKILLS_AS: 'me',   // the acting developer (the contract §7, Identity)
    });
    expect(sb.env.PATH.split(':')[0]).toBe(join(sb.root, 'bin'));
    expect(JSON.parse(readFileSync(join(sb.root, 'run.json'), 'utf8'))).toMatchObject({ run_id: sb.runId });
  });

  it('[2] the fail-safe refuses any run path under the real home', () => {
    const home = realHome();
    expect(home).toBe(userInfo().homedir);
    expect(() => failSafe([join(home, 'some', 'catalog')])).toThrow(FailSafeError);
    expect(() => failSafe([home])).toThrow(FailSafeError);
    expect(() => failSafe([join(tmpdir(), 'x')])).not.toThrow();
    // a sandbox whose tmp is under the (given) home is refused before anything is created
    const m = machine();
    const inside = join(m.home, 'tmp');
    expect(() => createSandbox({ runId: newRunId(), machine: { ...m, tmp: inside } })).toThrow(FailSafeError);
    expect(existsSync(join(inside, 'skills-catalog-qa'))).toBe(false);
  });

  it('[2] the fail-safe reads the home from the OS user record, so it still trips when HOME points elsewhere', () => {
    const src = fileURLToPath(new URL('../src/sandbox.ts', import.meta.url));
    const script = `import { failSafe } from ${JSON.stringify(src)}; import { join } from 'node:path'; import { userInfo } from 'node:os';
      try { failSafe([join(userInfo().homedir, 'leak')]); console.log('allowed'); } catch (e) { console.log(e.name); }`;
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HOME: scratch() }, encoding: 'utf8' });
    expect(out.trim()).toBe('FailSafeError');
  });

  it('[2] resolves symlinks before judging a path', () => {
    const m = machine();
    const link = join(scratch(), 'link-to-home');
    execFileSync('ln', ['-s', m.home, link]);
    expect(() => failSafe([join(link, 'catalog')], m.home)).toThrow(FailSafeError);
  });
});

describe('teardown', () => {
  it('[3] slugs a path the way Claude Code names its folders', () => {
    expect(slug('/private/var/folders/x/T/skills-catalog-qa/r.1/work')).toBe('-private-var-folders-x-T-skills-catalog-qa-r-1-work');
    expect(slug('/Users/me/ws/team_skills')).toBe('-Users-me-ws-team-skills');   // "_" too, as Claude Code does
  });

  it('[3] deletes the sandbox and the assistant leftovers keyed by the sandbox path and each session id, and nothing else', async () => {
    const m = machine();
    const sb = sandbox(m);
    const s = slug(join(sb.root, 'work'));
    expect(leftoverNames(sb.root)).toContain(s);
    const leftovers = [join(m.roots.claudeDir, 'projects', s, 'memory'), join(m.roots.claudeDir, 'session-env', UUID1), join(m.claudeTmp, s, UUID1)];
    for (const d of leftovers) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'f'), 'x'); }
    const others = [join(m.roots.claudeDir, 'projects', '-Users-me-other'), join(m.roots.claudeDir, 'session-env', 'someone-else'), join(m.claudeTmp, '-Users-me-other')];
    for (const d of others) mkdirSync(d, { recursive: true });
    const r = await teardown(sb, { machine: m, sessions: [UUID1], sessionEnvsBefore: new Set(['someone-else']) });
    expect(r.removed.sort()).toEqual([join(m.roots.claudeDir, 'projects', s), join(m.roots.claudeDir, 'session-env', UUID1), join(m.claudeTmp, s), sb.root].sort());
    expect(existsSync(sb.root)).toBe(false);
    for (const d of leftovers) expect(existsSync(d), d).toBe(false);
    for (const d of others) expect(existsSync(d), d).toBe(true);
  });

  it('[3] kills each process group the run started', async () => {
    const m = machine();
    const sb = sandbox(m);
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    await teardown(sb, { machine: m, processGroups: [pgid] });
    expect(alive(pgid)).toBe(false);
  });
});

describe('before/after check', () => {
  it('watches the product\'s default place, ~/.skills-catalog (contract §4.5; no XDG folders)', () => {
    expect(PRODUCT_DEFAULTS('/Users/me')).toEqual(['/Users/me/.skills-catalog']);
  });

  it('[5] sees a new folder, a new file and a changed file in the watched places', () => {
    const m = machine();
    const sb = sandbox(m);
    const w = m.watch(sb);
    mkdirSync(join(m.home, '.skills-catalog'), { recursive: true });
    writeFileSync(join(m.home, '.skills-catalog', 'config.json'), '{}');
    const before = snapshot(w);
    mkdirSync(join(m.roots.claudeDir, 'skills', 'leaked-skill'));                          // a folder, empty
    writeFileSync(join(m.home, '.skills-catalog', 'lock.json'), '{}');                        // a file
    writeFileSync(join(m.home, '.skills-catalog', 'config.json'), '{"changed":true}');       // a change
    expect(compare(before, snapshot(w)).map((d) => d.what)).toEqual([
      `added folder ${join(m.roots.claudeDir, 'skills', 'leaked-skill')}`,
      `changed file ${join(m.home, '.skills-catalog', 'config.json')}`,
      `added file ${join(m.home, '.skills-catalog', 'lock.json')}`,
    ]);
  });

  it('[5] watches only what a run could create: other sessions\' entries under ~/.claude are ignored', () => {
    const m = machine();
    const sb = sandbox(m);
    const before = snapshot(m.watch(sb, ['s-run']));
    mkdirSync(join(m.roots.claudeDir, 'projects', '-Users-me-other-project', 'memory'), { recursive: true });
    mkdirSync(join(m.roots.claudeDir, 'session-env', 'another-live-session'));
    mkdirSync(join(m.claudeTmp, '-Users-me-other-project'));
    expect(compare(before, snapshot(m.watch(sb, ['s-run'])))).toEqual([]);
    mkdirSync(join(m.roots.claudeDir, 'projects', slug(join(sb.root, 'work'))));
    mkdirSync(join(m.roots.claudeDir, 'session-env', 's-run'));
    expect(compare(before, snapshot(m.watch(sb, ['s-run']))).map((d) => d.what)).toEqual([
      `added folder ${join(m.roots.claudeDir, 'projects', slug(join(sb.root, 'work')))}`,
      `added folder ${join(m.roots.claudeDir, 'session-env', 's-run')}`,
    ]);
  });

  it('[5] checks only the keys a run could add in ~/.claude.json and settings.json', () => {
    const m = machine();
    const sb = sandbox(m);
    const w = m.watch(sb);
    writeFileSync(w.claudeJson, JSON.stringify({ numStartups: 1, mcpServers: {}, projects: { '/Users/me/x': {} } }));
    writeFileSync(w.settingsJson, JSON.stringify({ theme: 'dark' }));
    const before = snapshot(w);
    writeFileSync(w.claudeJson, JSON.stringify({ numStartups: 2, mcpServers: {}, projects: { '/Users/me/x': { lastCost: 1 } } }));   // other sessions' churn
    expect(compare(before, snapshot(w))).toEqual([]);
    writeFileSync(w.claudeJson, JSON.stringify({ numStartups: 2, mcpServers: { 'skills-catalog': {} }, projects: { '/Users/me/x': {}, [join(sb.root, 'work')]: {} } }));
    writeFileSync(w.settingsJson, JSON.stringify({ theme: 'dark', hooks: { SessionStart: [] } }));
    expect(compare(before, snapshot(w)).map((d) => d.what)).toEqual([
      `changed key mcpServers in ${w.claudeJson}`,
      `added key projects["${join(sb.root, 'work')}"] in ${w.claudeJson}`,
      `added key hooks in ${w.settingsJson}`,
    ]);
  });

  it('[5] fails on a process group the run left alive', async () => {
    const m = machine();
    const sb = sandbox(m);
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const w = { ...m.watch(sb), processGroups: [child.pid!] };
    expect(compare(snapshot({ ...w, processGroups: [] }), snapshot(w)).map((d) => d.what)).toEqual([`process group ${child.pid} still running`]);
    process.kill(-child.pid!, 'SIGKILL');
  });
});

describe('before/after check: processes and ports (plan §6.6)', () => {
  const listener = (env: NodeJS.ProcessEnv) => {
    const child = spawn(process.execPath, ['-e', "require('net').createServer().listen(0, '127.0.0.1', function () { console.log(this.address().port) })"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'], env });
    return { child, port: new Promise<string>((ok) => child.stdout!.once('data', (b) => ok(String(b).trim()))) };
  };

  it('a process is the run\'s only by its environment: QA_RUN_ID in its arguments doesn\'t count', async () => {
    const m = machine();
    const sb = sandbox(m);
    const decoy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', `QA_RUN_ID=${sb.runId}`], { detached: true, stdio: 'ignore', env: { ...process.env } });
    const ours = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { detached: true, stdio: 'ignore', env: { ...process.env, ...sb.env } });
    try {
      await runningOwnCommand([decoy.pid!, ours.pid!], /setTimeout/);
      expect(runProcesses(sb.runId).map((p) => p.pid)).toEqual([ours.pid]);
    } finally {
      for (const c of [decoy, ours]) process.kill(-c.pid!, 'SIGKILL');
    }
  });

  it('sees a process from this run that left its process group, and the port it listens on; ignores everyone else\'s', async () => {
    const m = machine();
    const sb = sandbox(m);
    const w = m.watch(sb);
    const before = snapshot(w);
    const ours = listener({ ...process.env, ...sb.env }), theirs = listener({ ...process.env });
    try {
      const port = await ours.port; await theirs.port;
      const whats = compare(before, snapshot(w)).map((d) => d.what);
      expect(whats).toHaveLength(2);
      expect(whats).toEqual(expect.arrayContaining([
        expect.stringMatching(new RegExp(`^process ${ours.child.pid} from this run still running`)),
        expect.stringMatching(new RegExp(`^port 127\\.0\\.0\\.1:${port} still listening \\(process ${ours.child.pid}\\)`)),
      ]));
    } finally {
      for (const c of [ours.child, theirs.child]) process.kill(-c.pid!, 'SIGKILL');
    }
  });
});

/** Waits until ps shows each process running its own command (a new process shows its parent's until it starts it). */
async function runningOwnCommand(pids: number[], command: RegExp): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 20) {
    const ps = execFileSync('ps', ['-o', 'pid=,command=', '-p', pids.join(',')], { encoding: 'utf8' });
    const shown = new Map(ps.split('\n').flatMap((l) => { const m = l.match(/^\s*(\d+) (.*)$/); return m ? [[Number(m[1]), m[2]!] as const] : []; }));
    if (pids.every((pid) => command.test(shown.get(pid) ?? ''))) return;
    await new Promise((ok) => setTimeout(ok, 20));
  }
  throw new Error(`processes ${pids.join(', ')} never showed ${command} in ps`);
}

function alive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}

describe('before/after check additions (brief §2.8; agent-experience.md, "Internal errors: no traceback")', () => {
  it('hashes the product repo checkout (not .git, node_modules or out) and the installed tool\'s files', () => {
    const m = machine();
    const sb = sandbox(m);
    const repo = join(scratch(), 'repo'), tool = join(scratch(), 'tool');
    for (const d of [join(repo, 'src'), join(repo, 'node_modules', 'x'), join(repo, 'out'), join(repo, '.git'), tool]) mkdirSync(d, { recursive: true });
    writeFileSync(join(repo, 'src', 'cli.ts'), 'ok');
    writeFileSync(join(tool, 'skills-catalog'), '#!/bin/sh');
    const w = { ...m.watch(sb), productRepo: repo, toolFiles: [tool] };
    const before = snapshot(w);
    writeFileSync(join(repo, 'node_modules', 'x', 'cache'), 'churn');   // ignored
    writeFileSync(join(repo, 'out', 'report.json'), '{}');              // ignored
    writeFileSync(join(repo, '.git', 'index'), 'churn');                // ignored
    expect(compare(before, snapshot(w))).toEqual([]);
    writeFileSync(join(repo, 'src', 'cli.ts'), 'patched by an assistant');
    writeFileSync(join(tool, 'skills-catalog'), '#!/bin/sh\nexit 0');
    expect(compare(before, snapshot(w)).map((d) => d.what).sort()).toEqual([   // sorted: two random temp folders
      `changed file ${join(repo, 'src', 'cli.ts')}`,
      `changed file ${join(tool, 'skills-catalog')}`,
    ].sort());
  });

  it('watches every key of settings.json, and the assistant\'s own settings keys in ~/.claude.json', () => {
    const m = machine();
    const sb = sandbox(m);
    const w = m.watch(sb);
    writeFileSync(w.claudeJson, JSON.stringify({ numStartups: 1 }));
    writeFileSync(w.settingsJson, JSON.stringify({ theme: 'dark' }));
    const before = snapshot(w);
    writeFileSync(w.claudeJson, JSON.stringify({ numStartups: 2, autoUpdatesChannel: 'latest' }));
    writeFileSync(w.settingsJson, JSON.stringify({ theme: 'dark', autoUpdatesChannel: 'latest' }));
    expect(compare(before, snapshot(w)).map((d) => d.what)).toEqual([
      `added key autoUpdatesChannel in ${w.claudeJson}`,
      `added key autoUpdatesChannel in ${w.settingsJson}`,
    ]);
  });
});
