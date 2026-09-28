// `qa run`'s clean-run machinery (qa-plan §6; brief §1): sandbox, fail-safe, teardown, janitor, before/after check.
// Every test works under a temporary "home" of its own (fake ~/.claude, fake /private/tmp/claude-<uid>), except the
// fail-safe tests, which only read the real home's path, and the self-check in qa-run.test.ts.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assistantLeftovers, slug } from '../src/leftovers.ts';
import { createSandbox, DIRS, FailSafeError, failSafe, realHome, recordSession } from '../src/sandbox.ts';
import { teardown } from '../src/teardown.ts';
import { janitor } from '../src/janitor.ts';
import { compare, snapshot, type Watch } from '../src/check.ts';

const made: string[] = [];
afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
const scratch = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'qa-test-'))); made.push(d); return d; };

/** A fake machine: its own tmp (where sandboxes go), ~/.claude, ~/.claude.json and /private/tmp/claude-<uid>. */
function machine() {
  const root = scratch();
  const m = { tmp: join(root, 'tmp'), home: join(root, 'home'), claudeTmp: join(root, 'private-tmp-claude') };
  for (const d of [m.tmp, join(m.home, '.claude', 'skills'), join(m.home, '.claude', 'projects'), join(m.home, '.claude', 'session-env'), m.claudeTmp]) mkdirSync(d, { recursive: true });
  const roots = { claudeDir: join(m.home, '.claude'), claudeTmp: m.claudeTmp };
  const watch = (sb: { root: string }, sessions: string[] = []): Watch => ({
    ...roots, claudeJson: join(m.home, '.claude.json'), settingsJson: join(m.home, '.claude', 'settings.json'),
    productDefaults: [join(m.home, '.skills-catalog')], sandboxRoot: sb.root, sessions, processGroups: [],
  });
  return { ...m, roots, watch };
}

describe('sandbox', () => {
  it('[1] makes the run folders and exports the SKILLS_* settings pointing into them', () => {
    const m = machine();
    const sb = createSandbox({ runId: 'r1', tmp: m.tmp, home: m.home });
    expect(sb.root).toBe(join(m.tmp, 'skills-catalog-qa', 'r1'));
    for (const d of DIRS) expect(existsSync(join(sb.root, d)), d).toBe(true);
    expect(DIRS).toEqual(['catalog', 'home', 'install', 'assistant', 'work', 'outside', 'bin']);
    expect(sb.env).toMatchObject({
      SKILLS_CATALOG: `file://${join(sb.root, 'catalog')}`,
      SKILLS_HOME: join(sb.root, 'home'),
      SKILLS_INSTALL_DIR: join(sb.root, 'install'),
      SKILLS_ASSISTANT_HOME: join(sb.root, 'assistant'),
      SKILLS_SYNC_ON_START: '0',
      SKILLS_AS: 'me',   // the acting developer (contract §7, Identity; the QA plan's 901aa2a)
    });
    expect(sb.env.PATH.split(':')[0]).toBe(join(sb.root, 'bin'));
    expect(JSON.parse(readFileSync(join(sb.root, 'run.json'), 'utf8'))).toMatchObject({ runId: 'r1' });
  });

  it('[2] the fail-safe refuses any run path under the real home', () => {
    const home = realHome();
    expect(home).toBe(userInfo().homedir);
    expect(() => failSafe([join(home, 'some', 'catalog')], home)).toThrow(FailSafeError);
    expect(() => failSafe([home], home)).toThrow(FailSafeError);
    expect(() => failSafe([join(tmpdir(), 'x')], home)).not.toThrow();
    // a sandbox whose tmp is under the (given) home is refused before anything is created
    const m = machine();
    const inside = join(m.home, 'tmp');
    expect(() => createSandbox({ runId: 'r2', tmp: inside, home: m.home })).toThrow(FailSafeError);
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
    expect(slug('/Users/me/ws/my_project')).toBe('-Users-me-ws-my-project');   // "_" too, as Claude Code does
  });

  it('[3] deletes the sandbox and the assistant leftovers keyed by the sandbox path and each session id, and nothing else', async () => {
    const m = machine();
    const sb = createSandbox({ runId: 'r3', tmp: m.tmp, home: m.home });
    recordSession(sb, 'sess-1');
    const s = slug(join(sb.root, 'work'));
    const leftovers = [join(m.roots.claudeDir, 'projects', s, 'memory'), join(m.roots.claudeDir, 'session-env', 'sess-1'), join(m.claudeTmp, s, 'sess-1')];
    for (const d of leftovers) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'f'), 'x'); }
    const others = [join(m.roots.claudeDir, 'projects', '-Users-me-other'), join(m.roots.claudeDir, 'session-env', 'someone-else'), join(m.claudeTmp, '-Users-me-other')];
    for (const d of others) mkdirSync(d, { recursive: true });
    expect(assistantLeftovers(sb.root, ['sess-1'], m.roots).sort()).toEqual([join(m.roots.claudeDir, 'projects', s), join(m.roots.claudeDir, 'session-env', 'sess-1'), join(m.claudeTmp, s)].sort());
    await teardown(sb, { roots: m.roots });
    expect(existsSync(sb.root)).toBe(false);
    for (const d of leftovers) expect(existsSync(d), d).toBe(false);
    for (const d of others) expect(existsSync(d), d).toBe(true);
  });

  it('[3] kills each process group the run started', async () => {
    const m = machine();
    const sb = createSandbox({ runId: 'r4', tmp: m.tmp, home: m.home });
    const child = spawn('sh', ['-c', 'sleep 30 & sleep 30'], { detached: true, stdio: 'ignore' });
    const pgid = child.pid!;
    await teardown(sb, { roots: m.roots, processGroups: [pgid] });
    expect(alive(pgid)).toBe(false);
  });
});

describe('janitor', () => {
  it('[4] removes runs older than the TTL, with their leftovers, and keeps fresh ones', () => {
    const m = machine();
    const old = createSandbox({ runId: 'old', tmp: m.tmp, home: m.home, now: () => Date.parse('2026-09-28T10:00:00Z') });
    recordSession(old, 'old-sess');
    const fresh = createSandbox({ runId: 'fresh', tmp: m.tmp, home: m.home, now: () => Date.parse('2026-09-28T11:50:00Z') });
    const oldLeft = join(m.roots.claudeDir, 'session-env', 'old-sess');
    const oldProject = join(m.roots.claudeDir, 'projects', slug(join(old.root, 'work')));
    for (const d of [oldLeft, oldProject]) mkdirSync(d, { recursive: true });
    const removed = janitor({ tmp: m.tmp, roots: m.roots, ttlMs: 60 * 60_000, now: () => Date.parse('2026-09-28T12:00:00Z') });
    expect(removed).toContain(old.root);
    expect(existsSync(old.root)).toBe(false);
    expect(existsSync(oldLeft)).toBe(false);
    expect(existsSync(oldProject)).toBe(false);
    expect(existsSync(fresh.root)).toBe(true);
  });

  it('[4] removes orphaned leftovers by name prefix once they are older than the TTL', () => {
    const m = machine();
    const base = join(m.tmp, 'skills-catalog-qa');
    mkdirSync(base, { recursive: true });
    const orphan = join(m.roots.claudeDir, 'projects', slug(join(base, 'gone', 'work')));
    const young = join(m.claudeTmp, slug(join(base, 'young', 'work')));
    for (const d of [orphan, young]) mkdirSync(d, { recursive: true });
    const hourAgo = (Date.now() - 2 * 3600_000) / 1000;
    utimesSync(orphan, hourAgo, hourAgo);
    janitor({ tmp: m.tmp, roots: m.roots, ttlMs: 60 * 60_000 });
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(young)).toBe(true);
  });
});

describe('before/after check', () => {
  it('[5] sees a new folder, a new file and a changed file in the watched places', () => {
    const m = machine();
    const sb = createSandbox({ runId: 'r5', tmp: m.tmp, home: m.home });
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
    const sb = createSandbox({ runId: 'r6', tmp: m.tmp, home: m.home });
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
    const sb = createSandbox({ runId: 'r7', tmp: m.tmp, home: m.home });
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
    const sb = createSandbox({ runId: 'r8', tmp: m.tmp, home: m.home });
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    const w = { ...m.watch(sb), processGroups: [child.pid!] };
    expect(compare(snapshot({ ...w, processGroups: [] }), snapshot(w)).map((d) => d.what)).toEqual([`process group ${child.pid} still running`]);
    process.kill(-child.pid!, 'SIGKILL');
  });
});

function alive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch { return false; }
}
