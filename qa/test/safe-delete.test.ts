// Safe deletion (qa-plan §6.5a; brief §1.6a), added after the QA tools failed a security review: the canaries, the fail-safe
// on the real home, and the guards that keep a test process away from the real places. Every test here uses a fake
// machine; the few that name a real place only check that it is refused, and nothing there exists or is created.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { platform, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { janitor } from '../src/janitor.ts';
import { leftoverNames } from '../src/leftovers.ts';
import { realMachine } from '../src/machine.ts';
import { DEFAULT_TIMEOUT_MS } from '../src/run.ts';
import { DEFAULT_TTL_MS } from '../src/janitor.ts';
import { removeLeftover, removeRun, RUN_ID, UnsafeError, verifyBase } from '../src/safe-delete.ts';
import { createSandbox, FailSafeError, failSafe, newRunId, realHome, recordProcessGroup, sandboxBase } from '../src/sandbox.ts';
import { teardown } from '../src/teardown.ts';
import { cleanup, PROCESS_TEST_MS, machine, qaBareSync, qaSync, scratch, spawnDetached, type TestMachine } from './machine.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });   // these tests start processes (see PROCESS_TEST_MS)

afterEach(cleanup);

const HOUR = 3600_000;
const T0 = Date.parse('2026-09-28T10:00:00Z');
const later = () => T0 + 2 * HOUR;
const deadPid = () => spawnSync('true').pid!;          // a process that has exited
const caseInsensitive = (() => { const d = scratch('qa-case-'); return existsSync(d.toUpperCase()); })();
const run = (m: TestMachine, at = T0) => createSandbox({ runId: newRunId(new Date(at)), machine: m, now: () => at });
/** Mark a run as finished long ago: its qa process is gone. */
const finished = (root: string) => {
  const f = join(root, 'run.json');
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), pid: deadPid() }));
};

describe('run ids and the base directory', () => {
  it('a run id is <UTC time>Z-<8 hex>: no dots, no slashes', () => {
    expect(newRunId(new Date('2026-09-29T00:12:34.567Z'))).toMatch(/^20260929T001234Z-[0-9a-f]{8}$/);
    expect(RUN_ID.test(newRunId())).toBe(true);
    for (const bad of ['..', '../x', 'r1', '20260929T001234Z-1234567', '20260929T001234Z-ABCDEF12', '20260929T001234-12345678', '20260929T001234Z-12345678/..'])
      expect(RUN_ID.test(bad), bad).toBe(false);
  });

  it('a run id with ".." is rejected before anything is created', () => {
    const m = machine();
    for (const runId of ['..', '../outside', '20260929T001234Z-12345678/../..'])
      expect(() => createSandbox({ runId, machine: m }), runId).toThrow(/run id/);
    expect(readdirSync(m.tmp)).toEqual([]);
  });

  it('the base is created 0700, and every run folder sits directly in it', () => {
    const m = machine();
    const sb = run(m);
    const base = sandboxBase(m.tmp);
    expect(sb.root).toBe(join(base, sb.runId));
    expect((execFileSync('stat', ['-f', '%Lp', base], { encoding: 'utf8' })).trim()).toBe('700');
    expect(() => verifyBase(base)).not.toThrow();
    expect(JSON.parse(readFileSync(join(sb.root, 'run.json'), 'utf8'))).toMatchObject({ run_id: sb.runId, pid: process.pid, started_at: new Date(T0).toISOString() });
  });

  it('a qa run times out before the janitor could take it for a stale run', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeLessThan(DEFAULT_TTL_MS);
  });
});

describe('canary: the base', () => {
  it('a symlinked base: nothing deleted, and the janitor stops', () => {
    const m = machine();
    const elsewhere = scratch('qa-elsewhere-');
    const victim = join(elsewhere, newRunId(new Date(T0)));
    mkdirSync(victim);
    writeFileSync(join(victim, 'run.json'), JSON.stringify({ run_id: victim.split('/').pop(), pid: deadPid(), started_at: new Date(T0).toISOString() }));
    chmodSync(elsewhere, 0o700);
    symlinkSync(elsewhere, sandboxBase(m.tmp));
    expect(() => janitor({ machine: m, now: later })).toThrow(UnsafeError);
    expect(existsSync(victim)).toBe(true);
  });

  it('a base with a mode other than 0700: nothing deleted, and the message says how to fix it', () => {
    const m = machine();
    const old = run(m); finished(old.root);
    chmodSync(sandboxBase(m.tmp), 0o755);
    expect(() => janitor({ machine: m, now: later })).toThrow(/mode 0?755, not 0700.*chmod 700/s);
    expect(existsSync(old.root)).toBe(true);
    expect(() => createSandbox({ runId: newRunId(), machine: m })).toThrow(UnsafeError);   // and no new run starts there
  });

  it.runIf(caseInsensitive)('a base named in a different case: refused (its real path is compared case-sensitively)', () => {
    const m = machine();
    run(m);
    const base = sandboxBase(m.tmp);
    const variant = base.replace(/skills-catalog-qa$/, 'SKILLS-CATALOG-QA');
    expect(existsSync(variant)).toBe(true);                                        // the same folder on this disk
    expect(() => verifyBase(variant)).toThrow(/case-sensitively/);
  });
});

describe('canary: run folders', () => {
  it('a symlinked run folder: skipped and reported, its target kept', () => {
    const m = machine();
    run(m);                                                                        // makes the base
    const target = scratch('qa-target-');
    writeFileSync(join(target, 'keep.txt'), 'x');
    const name = newRunId(new Date(T0));
    symlinkSync(target, join(sandboxBase(m.tmp), name));
    const r = janitor({ machine: m, now: later });
    expect(r.skipped).toContainEqual({ path: join(sandboxBase(m.tmp), name), why: expect.stringMatching(/not a real directory/) });
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
    expect(() => removeRun(sandboxBase(m.tmp), name)).toThrow(UnsafeError);
  });

  it('a live run is kept, however old: its qa process, or its process group, is still alive', async () => {
    const m = machine();
    const byPid = run(m);                                                          // pid = this test process
    const byGroup = run(m); finished(byGroup.root);
    const child = spawnDetached('sleep', ['30']);
    const f = join(byGroup.root, 'run.json');
    writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, 'utf8')), pgids: [child.pid] }));
    try {
      const r = janitor({ machine: m, now: later });
      expect(existsSync(byPid.root)).toBe(true);
      expect(existsSync(byGroup.root)).toBe(true);
      expect(r.skipped.filter((s) => /live run/.test(s.why)).map((s) => s.path).sort()).toEqual([byPid.root, byGroup.root].sort());
    } finally { process.kill(-child.pid!, 'SIGKILL'); }
  });

  it('an entry without run.json is skipped and reported, however old its mtime (no mtime fallback)', () => {
    const m = machine();
    run(m);
    const bare = join(sandboxBase(m.tmp), newRunId(new Date(T0)));
    mkdirSync(bare);
    const r = janitor({ machine: m, now: () => Date.now() + 10 * 24 * HOUR });
    expect(existsSync(bare)).toBe(true);
    expect(r.skipped).toContainEqual({ path: bare, why: expect.stringMatching(/no run\.json/) });
  });

  it('an entry that isn\'t named like a run is skipped and reported', () => {
    const m = machine();
    run(m);
    const odd = join(sandboxBase(m.tmp), 'not-a-run');
    mkdirSync(odd);
    expect(janitor({ machine: m, now: later }).skipped).toContainEqual({ path: odd, why: expect.stringMatching(/not a run id/) });
    expect(existsSync(odd)).toBe(true);
  });

  it('a link inside a run folder is removed, never followed: its target is kept', async () => {
    const m = machine();
    const sb = run(m);
    const outside = scratch('qa-outside-');
    writeFileSync(join(outside, 'keep.txt'), 'x');
    symlinkSync(outside, join(sb.dirs.work, 'link-out'));
    symlinkSync(join(outside, 'keep.txt'), join(sb.dirs.work, 'file-link'));
    await teardown(sb, { machine: m });
    expect(existsSync(sb.root)).toBe(false);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('x');
  });
});

describe('canary: leftovers outside the base', () => {
  const sessionEnv = (m: TestMachine, id: string) => join(m.roots.claudeDir, 'session-env', id);
  const UUID1 = '00000000-0000-4000-8000-000000000001';

  it('only the exact names built from the run\'s own sandbox: nothing is globbed', () => {
    const m = machine();
    const sb = run(m);
    const names = leftoverNames(sb.root);
    expect(names).toContain(sb.root.replace(/[^A-Za-z0-9]/g, '-') + '-work');
    expect(names.every((n) => n.startsWith(sandboxBase(m.tmp).replace(/[^A-Za-z0-9]/g, '-') + '-'))).toBe(true);
    const near = join(m.roots.claudeDir, 'projects', names[0] + '-work-sub');   // shares the prefix, not an exact name
    mkdirSync(near, { recursive: true });
    return teardown(sb, { machine: m }).then(() => expect(existsSync(near)).toBe(true));
  });

  it('a session id that isn\'t a UUID: refused, and reported', async () => {
    const m = machine();
    const sb = run(m);
    for (const id of ['sess-1', '..', 'projects']) mkdirSync(sessionEnv(m, id), { recursive: true });
    const r = await teardown(sb, { machine: m, sessions: ['sess-1', '..', 'projects', '../projects'], sessionEnvsBefore: new Set() });
    for (const id of ['sess-1', '..', 'projects']) expect(existsSync(sessionEnv(m, id)), id).toBe(true);
    expect(r.skipped.filter((s) => /not a UUID/.test(s.why))).toHaveLength(4);
  });

  it('a session folder that existed before the run is never deleted, whatever id the trace names', async () => {
    const m = machine();
    const sb = run(m);
    mkdirSync(sessionEnv(m, UUID1));
    const r = await teardown(sb, { machine: m, sessions: [UUID1], sessionEnvsBefore: new Set([UUID1]) });
    expect(existsSync(sessionEnv(m, UUID1))).toBe(true);
    expect(r.skipped).toContainEqual({ path: sessionEnv(m, UUID1), why: expect.stringMatching(/existed before the run/) });
  });

  it('a session id without the list from before the run is a programming error, not a deletion', async () => {
    const m = machine();
    const sb = run(m);
    await expect(teardown(sb, { machine: m, sessions: [UUID1] })).rejects.toThrow(/sessionEnvsBefore/);
    expect(existsSync(sb.root)).toBe(true);
  });

  it.runIf(caseInsensitive)('a leftover whose name differs only in case: refused (the entry must match exactly)', async () => {
    const m = machine();
    const sb = run(m);
    const exact = leftoverNames(sb.root).find((n) => n.endsWith('-work'))!;
    const variant = join(m.roots.claudeDir, 'projects', exact.toUpperCase());
    mkdirSync(variant);
    const r = await teardown(sb, { machine: m });
    expect(existsSync(variant)).toBe(true);
    expect(r.skipped).toContainEqual({ path: join(m.roots.claudeDir, 'projects', exact), why: expect.stringMatching(/case/) });
  });

  it('a leftover that is a link: the link is removed, its target kept', async () => {
    const m = machine();
    const sb = run(m);
    const target = scratch('qa-target-');
    writeFileSync(join(target, 'keep.txt'), 'x');
    const exact = leftoverNames(sb.root).find((n) => n.endsWith('-work'))!;
    symlinkSync(target, join(m.roots.claudeDir, 'projects', exact));
    await teardown(sb, { machine: m });
    expect(existsSync(join(m.roots.claudeDir, 'projects', exact))).toBe(false);
    expect(existsSync(join(target, 'keep.txt'))).toBe(true);
  });

  it('a parent that is a link (e.g. ~/.claude/projects pointing elsewhere): refused', () => {
    const m = machine();
    const real = scratch('qa-real-projects-');
    mkdirSync(join(real, 'x'));
    const parent = join(m.roots.claudeDir, 'projects');
    renameSync(parent, parent + '.moved');
    symlinkSync(real, parent);
    expect(() => removeLeftover(parent, 'x')).toThrow(/parent/);
    expect(existsSync(join(real, 'x'))).toBe(true);
  });

  it('a name outside the base\'s prefix, or colliding with another run\'s, is refused', () => {
    const m = machine();
    const a = run(m), b = run(m);
    const base = sandboxBase(m.tmp);
    const outsidePrefix = '-Users-me-other-project';
    mkdirSync(join(m.roots.claudeDir, 'projects', outsidePrefix));
    expect(() => removeLeftover(join(m.roots.claudeDir, 'projects'), outsidePrefix, { base, runRoot: a.root })).toThrow(/prefix/);
    const bName = leftoverNames(b.root)[0];
    mkdirSync(join(m.roots.claudeDir, 'projects', bName));
    expect(() => removeLeftover(join(m.roots.claudeDir, 'projects'), bName, { base, runRoot: a.root })).toThrow(/another run/);
    expect(existsSync(join(m.roots.claudeDir, 'projects', bName))).toBe(true);
  });
});

describe('the janitor', () => {
  it('removes a finished run older than the TTL, with its exact leftovers, and reports what it can\'t trust', () => {
    const m = machine();
    const old = run(m); finished(old.root);
    const project = join(m.roots.claudeDir, 'projects', leftoverNames(old.root).find((n) => n.endsWith('-work'))!);
    mkdirSync(project);
    writeFileSync(join(old.root, 'sessions.jsonl'), JSON.stringify('00000000-0000-4000-8000-000000000009') + '\n');
    mkdirSync(join(m.roots.claudeDir, 'session-env', '00000000-0000-4000-8000-000000000009'));
    const fresh = run(m, later() - 60_000);
    const r = janitor({ machine: m, now: later });
    expect(r.removed.sort()).toEqual([project, old.root].sort());
    expect(existsSync(fresh.root)).toBe(true);
    // a session id read from a sandbox file isn't trusted: reported, never deleted
    expect(existsSync(join(m.roots.claudeDir, 'session-env', '00000000-0000-4000-8000-000000000009'))).toBe(true);
    expect(r.skipped).toContainEqual({ path: join(m.roots.claudeDir, 'session-env', '00000000-0000-4000-8000-000000000009'), why: expect.stringMatching(/not deleted/) });
  });

  it('keeps a finished run younger than the TTL (not only live ones)', () => {
    const m = machine();
    const young = run(m, later() - 30 * 60_000); finished(young.root);          // finished 30 minutes before "now"
    const r = janitor({ machine: m, ttlMs: HOUR, now: later });
    expect(existsSync(young.root)).toBe(true);
    expect(r.removed).toEqual([]);
  });

  it('reports leftovers whose run folder is gone, and deletes none of them', () => {
    const m = machine();
    run(m);
    const orphan = join(m.roots.claudeDir, 'projects', sandboxBase(m.tmp).replace(/[^A-Za-z0-9]/g, '-') + '-20260101T000000Z-deadbeef-work');
    mkdirSync(orphan);
    const r = janitor({ machine: m, now: later });
    expect(existsSync(orphan)).toBe(true);
    expect(r.skipped).toContainEqual({ path: orphan, why: expect.stringMatching(/run folder is gone/) });
  });

  it('--dry-run lists what it would delete and deletes nothing', () => {
    const m = machine();
    const old = run(m); finished(old.root);
    const r = qaSync(m, ['janitor', '--dry-run', '--ttl', '1']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`would remove ${old.root}`);
    expect(existsSync(old.root)).toBe(true);
    const real = qaSync(m, ['janitor', '--ttl', '1']);
    expect(real.stdout).toContain(`removed ${old.root}`);
    expect(existsSync(old.root)).toBe(false);
  });
});

describe('the fail-safe', () => {
  it('always guards the real home: a `home` option adds a place to guard, never replaces it', () => {
    const fakeHome = scratch('qa-home-');
    expect(() => failSafe([join(realHome(), 'qa-never-created')], fakeHome)).toThrow(FailSafeError);
    expect(() => failSafe([join(fakeHome, 'x')], fakeHome)).toThrow(FailSafeError);
    expect(() => failSafe([join(tmpdir(), 'x')], fakeHome)).not.toThrow();
  });

  it.runIf(platform() === 'darwin')('a path naming the real home in another case is refused (macOS disks ignore case)', () => {
    expect(() => failSafe([join(realHome().toUpperCase(), 'qa-never-created')])).toThrow(FailSafeError);
  });
});

describe('a test process never deletes in the real places', () => {
  it('realMachine() refuses in a test process', () => {
    expect(() => realMachine()).toThrow(/test process/);
  });

  it('the tripwire refuses a deletion under the real home, the real Claude tmp folder or the real sandbox base, before looking', () => {
    const claudeTmp = join('/private/tmp', `claude-${userInfo().uid}`);
    for (const [parent, name] of [[join(realHome(), '.claude', 'projects'), 'qa-tripwire-never-exists'], [claudeTmp, 'qa-tripwire-never-exists']])
      expect(() => removeLeftover(parent, name), parent).toThrow(/tripwire/);
    expect(() => removeRun(sandboxBase(tmpdir()), newRunId())).toThrow(/tripwire/);
  });

  it('the tripwire also refuses creating a sandbox in the real base from a test process, before anything is made', () => {
    const m = machine();
    const inReal = { ...m, tmp: tmpdir() };                               // the real tmp, with a fake home and Claude folders
    const before = existsSync(sandboxBase(tmpdir())) ? readdirSync(sandboxBase(tmpdir())) : [];
    expect(() => createSandbox({ runId: newRunId(), machine: inReal })).toThrow(/tripwire/);
    expect(existsSync(sandboxBase(tmpdir())) ? readdirSync(sandboxBase(tmpdir())) : []).toEqual(before);
  });

  it('run.json is written whole (a temp file, then a rename): no temp file is left', () => {
    const m = machine();
    const sb = run(m);
    recordProcessGroup(sb, 12345);                                              // and when it's rewritten
    expect(readdirSync(sb.root).filter((n) => n.includes('run.json') && n !== 'run.json')).toEqual([]);
    expect(JSON.parse(readFileSync(join(sb.root, 'run.json'), 'utf8')).pgids).toEqual([12345]);
  });

  it('the qa command line in a test process refuses the real machine: it needs --fake-machine', () => {
    for (const a of [['janitor', '--dry-run'], ['run', '--', 'true']]) {
      const r = qaBareSync(a);
      expect(r.status, a.join(' ')).toBe(3);
      expect(r.stderr).toMatch(/test process/);
    }
  });
});
