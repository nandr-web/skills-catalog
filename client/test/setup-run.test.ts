// Setup's run (setup build notes §3, §4): everything checked first, then under setup.lock: config.json, the record
// (each entry pending), each changed file's backup then the file, the record again; a file another writer changed
// between the read and the place is read, merged and written again, up to 3 times; two backups of each file kept; the
// skills home and backups/ ignored by git; this runner's own stale temp files swept.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, Words } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { race, runnerFolders } from './race-fs.ts';

// The runner's own temp folder (on Linux, /tmp, written by everyone) isn't what these tests are about (race-fs.ts).
vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
beforeEach(() => runnerFolders());
afterEach(() => {
  race.stats = undefined;
});
import { hookGroup, mcpEntry } from '../src/machine/setup-entries.ts';
import { runSetup, type RunInput } from '../src/machine/setup-run.ts';
import { fileOf, golden } from './setup-golden.ts';

const S = Words.load();
const ID = '0123456789abcdef0123456789abcdef';
const file = (path: string, text = '', mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, text, { mode });
};

function world() {
  const dir = sandbox();
  const A = join(dir, 'home');
  const H = join(dir, 'skills-home');
  mkdirSync(A, { mode: 0o700 });
  const pkg = join(dir, 'pkg');
  file(join(pkg, 'package.json'), '{"name": "skills-catalog"}');
  file(join(pkg, 'src', 'cli.ts'));
  const node = join(dir, 'node-bin', 'node');
  file(node, '', 0o755);
  let t = Date.parse('2026-09-29T12:00:00Z');
  const input: RunInput = {
    assistantHome: A,
    skillsHome: H,
    env: { SKILLS_HOME: H, SKILLS_ASSISTANT_HOME: A },
    uid: process.getuid!(),
    node,
    script: join(pkg, 'src', 'cli.ts'),
    temporaryRoots: [join(sandbox(), 'temp')],
    words: S,
    newId: ID,
    config: { update_policy: 'auto' },
    now: () => (t += 1000),
  };
  return { dir, A, H, node, input, claudeJson: join(A, '.claude.json'), settingsJson: join(A, '.claude', 'settings.json') };
}
const mode = (p: string) => (statSync(p).mode & 0o7777).toString(8);
const stamp = (p: string) => {
  const s = statSync(p, { bigint: true });
  return `${s.ino}:${s.mtimeNs}`;
};
const backupsOf = (H: string, name: string) => (existsSync(join(H, 'backups')) ? readdirSync(join(H, 'backups')).filter((f) => f.endsWith(`-${name}`)).sort() : []);
const record = (H: string) => JSON.parse(readFileSync(join(H, 'setup-record.json'), 'utf8'));
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof CatalogError) return { code: e.code, data: e.data };
    throw e;
  }
  return undefined;
};

describe('setup\'s run', () => {
  it('a fresh home: both files made (0600, .claude 0700), the record and config written, no backup, git told to ignore', async () => {
    const { A, H, input, claudeJson, settingsJson } = world();
    const r = await runSetup(input);
    const run = r.plan.run;
    expect(JSON.parse(readFileSync(claudeJson, 'utf8'))).toEqual({ mcpServers: { 'skills-catalog': mcpEntry(run) } });
    expect(JSON.parse(readFileSync(settingsJson, 'utf8')).hooks.SessionStart).toEqual([hookGroup(run)]);
    expect([mode(claudeJson), mode(settingsJson), mode(join(A, '.claude')), mode(H)]).toEqual(['600', '600', '700', '700']);
    expect(record(H).entries.map((e: { kind: string; state: string }) => `${e.kind}:${e.state}`)).toEqual(['mcp_entry:written', 'hook_group:written', ...Array(8).fill('allow_rule:written')]);
    expect(record(H).created_files.map((f: { file: string }) => f.file)).toEqual([claudeJson, settingsJson]);
    expect(JSON.parse(readFileSync(join(H, 'config.json'), 'utf8'))).toEqual({ update_policy: 'auto' });
    expect(backupsOf(H, 'claude.json')).toEqual([]);
    expect(readFileSync(join(H, '.gitignore'), 'utf8')).toBe('*\n');
    expect(existsSync(join(H, 'setup.lock'))).toBe(false);
    expect(r.written).toEqual([claudeJson, settingsJson]);
  });

  it('other keys kept: one backup of each file, equal to what was there, and each file\'s mode kept', async () => {
    const { A, H, input, claudeJson, settingsJson } = world();
    mkdirSync(join(A, '.claude'), { mode: 0o700 });
    const c0 = fileOf(golden.kept_input.claude_json);
    const s0 = fileOf(golden.kept_input.settings_json);
    writeFileSync(claudeJson, c0, { mode: 0o600 });
    writeFileSync(settingsJson, s0, { mode: 0o640 });
    chmodSync(settingsJson, 0o640);
    await runSetup(input);
    const [bc] = backupsOf(H, 'claude.json');
    const [bs] = backupsOf(H, 'settings.json');
    expect(bc).toMatch(/^\d{8}T\d{6}Z-[0-9a-f]{4}-claude\.json$/);
    expect(readFileSync(join(H, 'backups', bc!), 'utf8')).toBe(c0);
    expect(readFileSync(join(H, 'backups', bs!), 'utf8')).toBe(s0);
    expect([mode(join(H, 'backups', bc!)), mode(join(H, 'backups')), mode(settingsJson)]).toEqual(['600', '700', '640']);
    expect(readFileSync(join(H, 'backups', '.gitignore'), 'utf8')).toBe('*\n');
    expect(record(H).backups.map((b: { file: string }) => b.file)).toEqual([claudeJson, settingsJson]);
    expect(record(H).created_files).toEqual([]);
  });

  it('a rerun writes no file: bytes, inode and time kept, no backup, the record as it was', async () => {
    const { H, input, claudeJson, settingsJson } = world();
    await runSetup(input);
    const before = [claudeJson, settingsJson, join(H, 'setup-record.json')].map(stamp);
    const r = await runSetup(input);
    expect([claudeJson, settingsJson, join(H, 'setup-record.json')].map(stamp)).toEqual(before);
    expect(r.written).toEqual([]);
    expect(backupsOf(H, 'claude.json')).toEqual([]);
  });

  it('node moved, again and again: replaced where it is; only the two newest backups of each file kept, a stray file left', async () => {
    const { H, input, node, claudeJson } = world();
    await runSetup(input);
    mkdirSync(join(H, 'backups'), { mode: 0o700 });
    writeFileSync(join(H, 'backups', 'notes.txt'), 'mine');
    for (const n of ['node2', 'node3', 'node4']) {
      const moved = join(dirname(node), n);
      file(moved, '', 0o755);
      await runSetup({ ...input, node: moved });
      expect(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers['skills-catalog'].command).toBe(moved);
    }
    expect(backupsOf(H, 'claude.json')).toHaveLength(2);
    expect(backupsOf(H, 'settings.json')).toHaveLength(2);
    expect(readFileSync(join(H, 'backups', 'notes.txt'), 'utf8')).toBe('mine');
    expect(record(H).backups).toHaveLength(4);
    // The newest kept: what node3's run left, before node4's.
    const newest = backupsOf(H, 'claude.json').at(-1)!;
    expect(JSON.parse(readFileSync(join(H, 'backups', newest), 'utf8')).mcpServers['skills-catalog'].command).toBe(join(dirname(node), 'node3'));
  });

  it('changed once between the read and the place: read, merged and written again; both there; the stale backup gone', async () => {
    const { H, input, claudeJson } = world();
    const c0 = fileOf(golden.kept_input.claude_json);
    writeFileSync(claudeJson, c0, { mode: 0o600 });
    const other = '{\n  "projects": {}\n}\n';
    await runSetup({ ...input, seams: { afterRead: (p, attempt) => void (p === claudeJson && attempt === 1 && writeFileSync(claudeJson, other)) } });
    const after = JSON.parse(readFileSync(claudeJson, 'utf8'));
    expect(Object.keys(after)).toEqual(['projects', 'mcpServers']);
    const backups = backupsOf(H, 'claude.json');
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(H, 'backups', backups[0]!), 'utf8')).toBe(other);
  });

  it('changed every time: assistant_file_changed after 3 tries, the file as the other writer left it, no temp file', async () => {
    const { A, input, claudeJson } = world();
    writeFileSync(claudeJson, '{}', { mode: 0o600 });
    let n = 0;
    const r = await refusal(runSetup({ ...input, seams: { afterRead: (p) => void (p === claudeJson && writeFileSync(claudeJson, JSON.stringify({ n: ++n }))) } }));
    expect(r).toEqual({ code: 'assistant_file_changed', data: { path: claudeJson } });
    expect(n).toBe(3);
    expect(readFileSync(claudeJson, 'utf8')).toBe('{"n":3}');
    expect(readdirSync(A).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('a crash after the first file: the record names it written and the other pending; a rerun finishes', async () => {
    const { H, input, claudeJson, settingsJson } = world();
    await expect(runSetup({ ...input, seams: { afterWrite: (p) => { if (p === claudeJson) throw new Error('crash'); } } })).rejects.toThrow('crash');
    const states = Object.fromEntries(record(H).entries.map((e: { kind: string; state: string }) => [e.kind, e.state]));
    expect(states).toEqual({ mcp_entry: 'written', hook_group: 'pending', allow_rule: 'pending' });
    expect(existsSync(settingsJson)).toBe(false);
    await runSetup(input);
    expect(existsSync(settingsJson)).toBe(true);
    expect(record(H).entries.every((e: { state: string }) => e.state === 'written')).toBe(true);
    expect(record(H).created_files.map((f: { file: string }) => f.file)).toEqual([claudeJson, settingsJson]);
  });

  it('a crash before any file is written: the record already names every entry, pending', async () => {
    const { H, input, claudeJson } = world();
    await expect(runSetup({ ...input, seams: { afterRead: (p) => { if (p === claudeJson) throw new Error('crash'); } } })).rejects.toThrow('crash');
    expect(existsSync(claudeJson)).toBe(false);
    expect(record(H).entries.map((e: { state: string }) => e.state)).toEqual(Array(10).fill('pending'));
  });

  it('a crash after a backup is made, before its file is written: the record already names the backup', async () => {
    const { H, input, claudeJson } = world();
    writeFileSync(claudeJson, fileOf(golden.kept_input.claude_json), { mode: 0o600 });
    await expect(runSetup({ ...input, seams: { afterRead: (p) => { if (p === claudeJson) throw new Error('crash'); } } })).rejects.toThrow('crash');
    const [bc] = backupsOf(H, 'claude.json');
    expect(record(H).backups.map((b: { path: string }) => b.path)).toEqual([join(H, 'backups', bc!)]);
  });

  it('sweeps its own temp files older than an hour from the assistant home and .claude, and nothing else', async () => {
    const { A, input } = world();
    mkdirSync(join(A, '.claude'), { mode: 0o700 });
    const old = join(A, '..claude.json.skills-catalog-0123456789ab.tmp');
    const oldSettings = join(A, '.claude', '.settings.json.skills-catalog-0123456789ab.tmp');
    const fresh = join(A, '..claude.json.skills-catalog-ba9876543210.tmp');
    const theirs = join(A, '.other.skills-catalog-0123456789ab.tmp');
    for (const p of [old, oldSettings, fresh, theirs]) writeFileSync(p, 'x');
    // Two hours before the run's clock (world(): 12:00Z); the fresh one was just written, after it.
    const hoursAgo = Date.parse('2026-09-29T10:00:00Z') / 1000;
    for (const p of [old, oldSettings, theirs]) utimesSync(p, hoursAgo, hoursAgo);
    await runSetup(input);
    expect([old, oldSettings, fresh, theirs].map((p) => existsSync(p))).toEqual([false, false, true, true]);
  });

  it('an assistant home reached through a link: written in its real folder, not refused as a changed folder', async () => {
    const { dir, A, input, claudeJson } = world();
    const linked = join(dir, 'linked-home');
    symlinkSync(A, linked);
    const r = await runSetup({ ...input, assistantHome: linked });
    expect(r.written).toHaveLength(2);
    expect(existsSync(claudeJson)).toBe(true);
    expect(lstatSync(linked).isSymbolicLink()).toBe(true);
  });

  it('another run holding setup.lock (or a link in its place): lock_busy, nothing written', async () => {
    const { dir, H, input, claudeJson } = world();
    mkdirSync(H, { mode: 0o700 });
    writeFileSync(join(dir, 'elsewhere'), '');
    symlinkSync(join(dir, 'elsewhere'), join(H, 'setup.lock'));
    let t = 0;
    const r = await refusal(runSetup({ ...input, now: () => (t += 1000) }));
    expect(r).toEqual({ code: 'lock_busy', data: { path: join(H, 'setup.lock'), pid: null } });
    expect(existsSync(claudeJson)).toBe(false);
    expect(lstatSync(join(H, 'setup.lock')).isSymbolicLink()).toBe(true);
  });
});
