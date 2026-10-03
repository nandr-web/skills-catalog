// Teardown (setup build notes §5; qa/golden/setup.yaml's teardown rows): setup then teardown gives back the person's
// files byte for byte (a file setup created is gone); an entry the person changed is left and named; a rule that was
// there before setup stays; a damaged lock or config doesn't stop it; a damaged record removes nothing; a path the record
// names elsewhere is never touched; the terminal's launcher goes only while it's setup's.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerFolders } from './race-fs.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
beforeEach(() => runnerFolders());
import { runSetupCommand, type SetupIo } from '../src/cli/setup.ts';
import { runTeardownCommand } from '../src/cli/teardown.ts';
import { isOwnBackupCopy } from '../src/machine/teardown-run.ts';
import { cliWords } from '../src/cli/words.ts';
import { fileOf, golden } from './setup-golden.ts';

const S = cliWords(Words.load());
const T = S.setup.teardown;
const file = (path: string, text = '', mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, text, { mode });
};

function world() {
  const dir = sandbox();
  const A = join(dir, 'home');
  const H = join(A, '.skills-catalog');
  mkdirSync(A, { mode: 0o700 });
  const pkg = join(dir, 'pkg');
  file(join(pkg, 'package.json'), '{"name": "skills-catalog"}');
  file(join(pkg, 'src', 'cli.ts'));
  const node = join(dir, 'node-bin', 'node');
  file(node, '', 0o755);
  let t = Date.parse('2026-10-03T12:00:00Z');
  const out: string[] = [];
  const env = { HOME: A, USER: 'ana', SKILLS_HOME: H, SKILLS_ASSISTANT_HOME: A, SKILLS_MANAGED_SETTINGS: join(dir, 'managed'), PATH: '/usr/bin' };
  const io: SetupIo = {
    env, cwd: dir, tty: false, color: false, ask: async () => '',
    stdout: (x) => void out.push(x), stderr: (x) => void out.push(x),
    install: { node, script: join(pkg, 'src', 'cli.ts'), temporaryRoots: [join(sandbox(), 'temp')] },
    uid: process.getuid!(), now: () => (t += 1000),
  };
  const teardown = () => runTeardownCommand([], { env, cwd: dir, color: false, stdout: (x) => void out.push(x), stderr: (x) => void out.push(x), now: () => (t += 1000) });
  const claudeJson = join(A, '.claude.json');
  const settingsJson = join(A, '.claude', 'settings.json');
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  return { dir, A, H, io, teardown, claudeJson, settingsJson, read, out: () => out.join(''), clear: () => out.splice(0) };
}

describe('teardown', () => {
  it('untouched: the person\'s files byte for byte as before setup; backups kept; the launcher gone', async () => {
    const w = world();
    const before = { claude: fileOf(golden.kept_input.claude_json), settings: fileOf(golden.kept_input.settings_json) };
    file(w.claudeJson, before.claude, 0o600);
    file(w.settingsJson, before.settings, 0o600);
    expect(await runSetupCommand(['--yes'], w.io)).toBe(0);
    expect(w.read(w.claudeJson)).not.toBe(before.claude);
    expect(await w.teardown()).toBe(0);
    expect(w.read(w.claudeJson)).toBe(before.claude);
    expect(w.read(w.settingsJson)).toBe(before.settings);
    expect(existsSync(join(w.A, '.local', 'bin', 'skills-catalog'))).toBe(false);
    expect(readdirSync(join(w.H, 'backups')).length).toBeGreaterThan(0);
    expect(w.out()).toContain(T.header);
    expect(w.out()).toContain(S.format(T.removed, { path: w.claudeJson, what: T.what.mcp }).replace(/^- /, ''));
    expect(w.out()).toContain(S.format(T.removed, { path: join(w.A, '.local', 'bin', 'skills-catalog'), what: T.what.command }).replace(/^- /, ''));
  });

  it('the launcher\'s folders setup made go once empty; ones that were there, or hold something else, stay', async () => {
    const a = world();
    await runSetupCommand(['--yes'], a.io);
    await a.teardown();
    expect(existsSync(join(a.A, '.local'))).toBe(false);
    const b = world();
    mkdirSync(join(b.A, '.local'), { mode: 0o700 });
    await runSetupCommand(['--yes'], b.io);
    writeFileSync(join(b.A, '.local', 'bin', 'other-tool'), 'x');
    await b.teardown();
    expect(existsSync(join(b.A, '.local', 'bin', 'other-tool'))).toBe(true);
    const c = world();
    mkdirSync(join(c.A, '.local'), { mode: 0o700 });
    await runSetupCommand(['--yes'], c.io);
    await c.teardown();
    expect([existsSync(join(c.A, '.local', 'bin')), existsSync(join(c.A, '.local'))]).toEqual([false, true]);
  });

  it('fresh: the files setup created from nothing are deleted; .claude stays', async () => {
    const w = world();
    await runSetupCommand(['--yes'], w.io);
    expect(await w.teardown()).toBe(0);
    expect(existsSync(w.claudeJson)).toBe(false);
    expect(existsSync(w.settingsJson)).toBe(false);
    expect(existsSync(join(w.A, '.claude'))).toBe(true);
    expect(existsSync(join(w.H, 'setup-record.json'))).toBe(false);
    expect(JSON.parse(w.read(join(w.H, 'config.json'))!).me).toBe('ana');   // config.json is kept
  });

  it('then setup again works, and teardown again', async () => {
    const w = world();
    await runSetupCommand(['--yes'], w.io);
    await w.teardown();
    expect(await runSetupCommand(['--yes'], w.io)).toBe(0);
    expect(await w.teardown()).toBe(0);
    expect(existsSync(w.claudeJson)).toBe(false);
  });

  it('an entry the person changed is left and named; the rest removed', async () => {
    const w = world();
    file(w.claudeJson, '{\n  "numStartups": 1\n}\n', 0o600);
    await runSetupCommand(['--yes'], w.io);
    const c = JSON.parse(w.read(w.claudeJson)!);
    c.mcpServers['skills-catalog'].args[1] = 'serve';
    writeFileSync(w.claudeJson, JSON.stringify(c, null, 2) + '\n');
    const edited = w.read(w.claudeJson);
    expect(await w.teardown()).toBe(0);
    expect(w.read(w.claudeJson)).toBe(edited);
    expect(w.out()).toContain(S.format(T.changed, { path: w.claudeJson, what: T.what.mcp }).replace(/^- /, ''));
    expect(existsSync(w.settingsJson)).toBe(false);
  });

  it('a rule that was there before setup stays', async () => {
    const w = world();
    const before = '{\n  "permissions": {\n    "allow": [\n      "Bash(skills-catalog update)"\n    ]\n  }\n}\n';
    file(w.settingsJson, before, 0o600);
    await runSetupCommand(['--yes'], w.io);
    await w.teardown();
    expect(w.read(w.settingsJson)).toBe(before);
  });

  it('a damaged lock.json and config.json don\'t stop it; both named, untouched', async () => {
    const w = world();
    await runSetupCommand(['--yes'], w.io);
    writeFileSync(join(w.H, 'lock.json'), 'not json');
    writeFileSync(join(w.H, 'config.json'), 'not json');
    expect(await w.teardown()).toBe(0);
    expect(existsSync(w.claudeJson)).toBe(false);
    expect(w.read(join(w.H, 'config.json'))).toBe('not json');
    expect(w.out()).toContain(S.format(T.damaged, { path: join(w.H, 'config.json') }));
  });

  it('a damaged record: nothing removed, the look-alikes named for removing by hand, exit 1', async () => {
    const w = world();
    await runSetupCommand(['--yes'], w.io);
    const before = [w.read(w.claudeJson), w.read(w.settingsJson)];
    writeFileSync(join(w.H, 'setup-record.json'), 'not json');
    expect(await w.teardown()).toBe(1);
    expect([w.read(w.claudeJson), w.read(w.settingsJson)]).toEqual(before);
    expect(w.out()).toContain(S.format(T.record_unusable_line, { path: w.claudeJson, what: T.what.mcp }));
  });

  it('a launcher the person changed stays, named', async () => {
    const w = world();
    await runSetupCommand(['--yes'], w.io);
    const launcher = join(w.A, '.local', 'bin', 'skills-catalog');
    writeFileSync(launcher, '#!/bin/sh\necho mine\n');
    await w.teardown();
    expect(w.read(launcher)).toBe('#!/bin/sh\necho mine\n');
    expect(w.out()).toContain(S.format(T.changed, { path: launcher, what: T.what.command }).replace(/^- /, ''));
  });

  it('a backup the record names outside the backups folder is never deleted, even when it\'s the oldest to prune (review blocker)', async () => {
    const w = world();
    const victim = join(w.dir, 'victim.txt');
    file(victim, 'mine\n');
    file(w.claudeJson, '{\n  "numStartups": 1\n}\n', 0o600);
    await runSetupCommand(['--yes'], w.io);
    const recordPath = join(w.H, 'setup-record.json');
    const r = JSON.parse(w.read(recordPath)!);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update('mine\n').digest('hex');
    const one = r.backups[0] ?? { file: w.claudeJson, dev: 1, ino: 1, birth: 0 };
    r.backups = [{ ...one, file: w.claudeJson, path: victim, sha256: sha }, ...r.backups, { ...one, file: w.claudeJson, path: victim, sha256: sha }];
    writeFileSync(recordPath, JSON.stringify(r));
    await w.teardown();
    expect(w.read(victim)).toBe('mine\n');
  });

  it('a backup-shaped file outside backups/ is never deleted', async () => {
    const w = world();
    const victim = join(w.dir, '20260101T000000Z-abcd-claude.json');
    file(victim, 'mine\n');
    file(w.claudeJson, '{\n  "numStartups": 1\n}\n', 0o600);
    await runSetupCommand(['--yes'], w.io);
    const recordPath = join(w.H, 'setup-record.json');
    const r = JSON.parse(w.read(recordPath)!);
    const { createHash } = await import('node:crypto');
    const sha = createHash('sha256').update('mine\n').digest('hex');
    const one = r.backups[0] ?? { dev: 1, ino: 1, birth: 0 };
    r.backups = [{ ...one, file: w.claudeJson, path: victim, sha256: sha }, ...r.backups, { ...one, file: w.claudeJson, path: victim, sha256: sha }];
    writeFileSync(recordPath, JSON.stringify(r));
    await w.teardown();
    expect(w.read(victim)).toBe('mine\n');
  });

  it('the pruning boundary: each part refuses on its own', () => {
    const backups = '/k/backups';
    const name = '20260101T000000Z-abcd-claude.json';
    const ok = { path: join(backups, name), file: '/h/.claude.json' };
    expect(isOwnBackupCopy(ok, backups, new Set())).toBe(true);
    expect(isOwnBackupCopy({ ...ok, path: join('/k', name) }, backups, new Set())).toBe(false);      // another folder
    expect(isOwnBackupCopy({ ...ok, path: join(backups, 'notes.txt') }, backups, new Set())).toBe(false);   // another name
    expect(isOwnBackupCopy(ok, backups, new Set([ok.path]))).toBe(false);   // named elsewhere by the record
    expect(isOwnBackupCopy(ok, backups, new Set([ok.file]))).toBe(false);
  });

  it('nothing set up: says so, changes nothing', async () => {
    const w = world();
    expect(await w.teardown()).toBe(0);
    expect(w.out()).toContain(T.nothing);
    expect(readdirSync(w.A)).toEqual([]);
  });
});
