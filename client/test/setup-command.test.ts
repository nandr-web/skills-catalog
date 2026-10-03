// `skills-catalog setup` (contract §6; setup build notes §8, §9; qa/golden/setup.yaml's answers rows): one question table
// for the wizard, the flags, --config and the no-terminal list; with no terminal and questions left nothing changes
// (exit 3); --yes, --config and the wizard give the same files byte for byte; --config's refusals change nothing; a dry
// run prints the plan and changes nothing; the summary says what was written, in words, colour never alone.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runnerFolders } from './race-fs.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
beforeEach(() => runnerFolders());
import { CONFIG_KEYS } from '../src/machine/lock.ts';
import { NON_QUESTION_KEYS, QUESTIONS, runSetupCommand, SETUP_FLAGS, setupDoc, sharedFolderKind, type SetupIo } from '../src/cli/setup.ts';
import { PROCESS_COMMANDS } from '../src/cli/process.ts';
import { runTeardownCommand } from '../src/cli/teardown.ts';
import { cliWords } from '../src/cli/words.ts';

const S = cliWords(Words.load());
const ID = '0123456789abcdef0123456789abcdef';
const file = (path: string, text = '', mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, text, { mode });
};

/** A sandbox with a home, a fake install (node and the package) and the io a run gets; `typed` answers the prompts. */
function world(o: { tty?: boolean; typed?: string[]; env?: Record<string, string> } = {}) {
  const dir = sandbox();
  const A = join(dir, 'home');
  const H = join(A, '.skills-catalog');
  mkdirSync(A, { mode: 0o700 });
  const pkg = join(dir, 'pkg');
  file(join(pkg, 'package.json'), '{"name": "skills-catalog"}');
  file(join(pkg, 'src', 'cli.ts'));
  const node = join(dir, 'node-bin', 'node');
  file(node, '', 0o755);
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const typed = [...(o.typed ?? [])];
  let t = Date.parse('2026-10-03T12:00:00Z');
  const io: SetupIo = {
    env: { HOME: A, USER: 'Ana', SKILLS_HOME: H, SKILLS_ASSISTANT_HOME: A, SKILLS_MANAGED_SETTINGS: join(dir, 'managed'), PATH: '/usr/bin:/bin', ...o.env },
    cwd: dir,
    tty: o.tty ?? false,
    color: o.tty ?? false,
    ask: async (q) => {
      asked.push(q);
      return typed.shift() ?? '';
    },
    stdout: (x) => void out.push(x),
    stderr: (x) => void err.push(x),
    install: { node, script: join(pkg, 'src', 'cli.ts'), temporaryRoots: [join(sandbox(), 'temp')] },
    uid: process.getuid!(),
    now: () => (t += 1000),
    newId: ID,
  };
  const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : undefined);
  const files = () => ({ config: read(join(H, 'config.json')), claude: read(join(A, '.claude.json')), settings: read(join(A, '.claude', 'settings.json')), command: read(join(A, '.local', 'bin', 'skills-catalog')) });
  return { dir, A, H, io, out: () => out.join(''), err: () => err.join(''), asked, files };
}

describe('the question table', () => {
  it('each question has its flag in the words, in the same order; each config key is a question\'s or one setup never asks', () => {
    const words = S.setup.questions as { flag: string }[];
    expect(words.map((w) => w.flag.split(' ')[0])).toEqual(QUESTIONS.map((q) => `--${q.flag}`));
    const keys = Object.keys(CONFIG_KEYS);
    for (const q of QUESTIONS) expect(keys, q.key).toContain(q.key);
    // Contract §6's keys setup never asks about; any other key is a question's, or the table and the config drifted.
    const notAsked = ['hosting', 'overrides', 'cooldown', 'accept_flagged_updates', 'safe_frontmatter_keys', 'non_granting_keys', 'context_cost_budget', 'command_instruction_patterns', 'session_start_hook', 'claude_config_dir', 'aws'];
    expect([...NON_QUESTION_KEYS].sort()).toEqual(notAsked.sort());
  });
});

describe('the setup doc an assistant follows (skill-setup-by-agent)', () => {
  it('docs/setup.md is what `npm run setup-doc` writes now: the words\' doc, the assistant note, and every question with its flag', () => {
    const page = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'setup.md'), 'utf8');
    expect(page === setupDoc(S), 'docs/setup.md is out of date: run `npm run setup-doc` in client/').toBe(true);
    for (const q of S.setup.questions as { flag: string }[]) expect(page).toContain(q.flag.split(' ')[0]);
    expect(page).toContain(`${S.cli} setup --yes`);
  });
});

describe('the CLI\'s list of setup\'s flags', () => {
  it('is the table\'s', () => expect([...PROCESS_COMMANDS['setup']!.flags].sort()).toEqual([...SETUP_FLAGS].sort()));
});

describe('no terminal', () => {
  it('without --yes, nothing is made and every question is listed with its flag and default (exit 3)', async () => {
    const w = world();
    expect(await runSetupCommand([], w.io)).toBe(3);
    for (const q of S.setup.questions as { flag: string }[]) expect(w.out()).toContain(q.flag);
    expect(w.out()).toContain('default: ana');
    expect(w.out()).toContain(`${S.cli} setup --yes`);
    expect(existsSync(w.H)).toBe(false);
    expect(readdirSync(w.A)).toEqual([]);
  });

  it('flags answer what they answer; only the questions left are listed', async () => {
    const w = world();
    expect(await runSetupCommand(['--auto-update', 'no', '--me', 'ana', '--catalog', 'cat', '--for', 'claude-code', '--terminal-command', 'no'], w.io)).toBe(3);
    expect(w.out()).toContain('--demo-developers');
    expect(w.out()).not.toContain('--auto-update');
    expect(await runSetupCommand(['--auto-update', 'no', '--me', 'ana', '--catalog', 'cat', '--for', 'claude-code', '--terminal-command', 'no', '--no-demo-developers'], w.io)).toBe(0);
    expect(JSON.parse(w.files().config!)).toEqual({ update_policy: 'notify', catalog: `file://${join(w.dir, 'cat')}`, me: 'ana', terminal_command: false });
  });
});

describe('--yes: every default', () => {
  it('auto-updates on, the local catalog, the login as the name, the launcher; the summary says what was written', async () => {
    const w = world();
    expect(await runSetupCommand(['--yes'], w.io)).toBe(0);
    expect(JSON.parse(w.files().config!)).toEqual({ update_policy: 'auto', me: 'ana', terminal_command: true });
    expect(JSON.parse(w.files().claude!).mcpServers['skills-catalog'].env.SKILLS_SETUP_ID).toBe(ID);
    expect(w.files().command).toContain("exec '");
    const out = w.out();
    expect(out).toContain(S.setup.updates_auto);
    expect(out).toContain(S.format(S.setup.done_me, { me: 'ana' }));
    expect(out).toContain(join(w.A, '.claude.json'));
    expect(out).toContain(S.format(S.setup.command_off_path, { folder: join(w.A, '.local', 'bin') }));
    expect(out).not.toMatch(/\u001b\[/);   // no colour without a terminal
    expect((statSync(join(w.H, 'config.json')).mode & 0o777).toString(8)).toBe('600');
  });

  it('a rerun changes nothing and says so', async () => {
    const w = world();
    await runSetupCommand(['--yes'], w.io);
    const before = w.files();
    const w2 = { ...w.io, stdout: (x: string) => void outs.push(x) };
    const outs: string[] = [];
    expect(await runSetupCommand(['--yes'], w2)).toBe(0);
    expect(w.files()).toEqual(before);
    expect(outs.join('')).toContain(S.setup.plan.unchanged);
  });

  it('a home with an apostrophe and a space: the PATH line and the runnable command are quoted for the shell', async () => {
    const w = world();
    const A = join(w.dir, "o'neil home");
    mkdirSync(A, { mode: 0o700 });
    w.io.env['SKILLS_ASSISTANT_HOME'] = A;
    expect(await runSetupCommand(['--yes'], w.io)).toBe(0);
    const folder = join(A, '.local', 'bin');
    expect(w.out()).toContain(`export PATH='${folder.replaceAll("'", "'\\''")}':"$PATH"`);
  });

  it('the launcher\'s folder on PATH: no PATH line', async () => {
    const w = world();
    w.io.env['PATH'] = `${join(w.A, '.local', 'bin')}:/usr/bin`;
    await runSetupCommand(['--yes'], w.io);
    expect(w.out()).not.toContain("isn't on your PATH");
  });

  it('two demo developers when asked; the summary says how to act as one', async () => {
    const w = world();
    expect(await runSetupCommand(['--yes', '--demo-developers'], w.io)).toBe(0);
    expect(JSON.parse(w.files().config!).demo_developers).toEqual(['dev1', 'dev2']);
    expect(w.out()).toContain(S.format(S.setup.done_demo, { names: 'dev1, dev2' }));
  });
});

describe('three ways, the same files (skill-setup-unattended)', () => {
  it('--yes with flags, --config with the same answers, and the same answers typed at the wizard', async () => {
    const flags = ['--auto-update', 'no', '--me', 'bob', '--demo-developers', '--terminal-command', 'yes'];
    const a = world();
    expect(await runSetupCommand(['--yes', ...flags], a.io)).toBe(0);
    const b = world();
    const conf = join(b.dir, 'answers.json');
    writeFileSync(conf, JSON.stringify({ update_policy: 'notify', me: 'bob', demo_developers: ['dev1', 'dev2'], terminal_command: true }));
    expect(await runSetupCommand(['--yes', '--config', conf], b.io)).toBe(0);
    const c = world({ tty: true, typed: ['no', '', '', 'bob', 'y', 'yes', ''] });
    expect(await runSetupCommand([], c.io)).toBe(0);
    const norm = (w: ReturnType<typeof world>) => Object.fromEntries(Object.entries(w.files()).map(([k, v]) => [k, v?.split(w.dir).join('<dir>')]));
    expect(norm(b)).toEqual(norm(a));
    expect(norm(c)).toEqual(norm(a));
  });
});

describe('session_start_hook: false (contract §6)', () => {
  it('in a --config file: saved, no hook written (the allow rules still are), the plan says so; teardown removes the rest', async () => {
    const w = world();
    const path = join(w.dir, 'answers.json');
    writeFileSync(path, JSON.stringify({ session_start_hook: false }));
    expect(await runSetupCommand(['--yes', '--config', path], w.io)).toBe(0);
    expect(JSON.parse(w.files().config!).session_start_hook).toBe(false);
    const settings = JSON.parse(w.files().settings!);
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions.allow.length).toBeGreaterThan(0);
    expect(w.out()).toContain(S.format(S.setup.plan.rules_add, { path: join(w.A, '.claude', 'settings.json'), rules: settings.permissions.allow.length }));
    const record = JSON.parse(readFileSync(join(w.H, 'setup-record.json'), 'utf8'));
    expect(record.entries.some((e: { kind: string }) => e.kind === 'hook_group')).toBe(false);
    expect(await runTeardownCommand([], { env: w.io.env, cwd: w.dir, color: false, stdout: () => {}, stderr: () => {} })).toBe(0);
    expect(w.files().settings).toBeUndefined();
  });

  it('a person\'s file: only the rules are added, the hooks they have are kept as they are', async () => {
    const w = world();
    const before = '{\n  "hooks": {\n    "SessionStart": []\n  }\n}\n';
    file(join(w.A, '.claude', 'settings.json'), before, 0o600);
    const path = join(w.dir, 'answers.json');
    writeFileSync(path, JSON.stringify({ session_start_hook: false }));
    expect(await runSetupCommand(['--yes', '--config', path], w.io)).toBe(0);
    expect(JSON.parse(w.files().settings!).hooks).toEqual({ SessionStart: [] });
  });
});

describe('the wizard (skill-setup-welcome)', () => {
  it('a welcome, each question with its default in brackets, in colour at a terminal; a wrong answer is asked again', async () => {
    const w = world({ tty: true, typed: ['maybe', 'yes', '', '', '', '', '', ''] });
    expect(await runSetupCommand([], w.io)).toBe(0);
    expect(w.out()).toContain(S.format(S.setup.welcome, { n: QUESTIONS.length }));
    expect(w.out()).toMatch(/\u001b\[/);
    expect(w.asked[0]).toContain('[yes]');
    expect(w.asked[1]).toContain('[yes]');   // asked again after "maybe"
    expect(w.err()).toContain('--auto-update');
    expect(w.asked.at(-1)).toContain(S.setup.plan.ask);
    expect(JSON.parse(w.files().config!).update_policy).toBe('auto');
  });

  it('a no at "Go ahead?" changes nothing', async () => {
    const w = world({ tty: true, typed: ['', '', '', '', '', '', 'n'] });
    expect(await runSetupCommand([], w.io)).toBe(0);
    expect(w.out()).toContain(S.setup.plan.declined);
    expect(existsSync(join(w.A, '.claude.json'))).toBe(false);
  });
});

describe('--config refusals change nothing', () => {
  const cases: [string, Record<string, unknown>, string[], string][] = [
    ['accept_flagged_updates on', { accept_flagged_updates: true }, [], 'accept_flagged_updates'],
    ['an unknown key', { unknown_key: 1 }, [], 'unknown_key'],
    ['a flag contradicting the file', { me: 'ana' }, ['--me', 'bob'], '--me'],
    ['a name that isn\'t one', { me: 'Not A Name' }, [], 'me'],
  ];
  for (const [what, conf, extra, field] of cases) {
    it(what, async () => {
      const w = world();
      const path = join(w.dir, 'answers.json');
      writeFileSync(path, JSON.stringify(conf));
      expect(await runSetupCommand(['--yes', '--config', path, ...extra], w.io)).toBe(1);
      expect(w.err()).toMatch(/^invalid_request: /);
      expect(w.err()).toContain(field);
      expect(existsSync(w.H)).toBe(false);
    });
  }
});

describe('a catalog address is one address (review: an escape sequence was stored and printed raw)', () => {
  const bad = ['https://ex.com/\u001b[31mRED\u001b[0m', 'https://ex.com/a\nfake line', 'https://ex .com/', 'https://', 'ftp://ex.com/'];
  for (const v of bad) {
    it(`refused as a flag and in a --config file: ${JSON.stringify(v)}`, async () => {
      const w = world();
      expect(await runSetupCommand(['--yes', '--catalog', v], w.io)).toBe(1);
      const path = join(w.dir, 'answers.json');
      writeFileSync(path, JSON.stringify({ catalog: v }));
      expect(await runSetupCommand(['--yes', '--config', path], w.io)).toBe(1);
      expect(w.out() + w.err()).not.toContain('\u001b[31m');
      expect(existsSync(w.H)).toBe(false);
    });
  }

  it('a hosted catalog\'s address is kept and the summary points to login', async () => {
    const w = world();
    expect(await runSetupCommand(['--yes', '--catalog', 'https://catalog.example/team'], w.io)).toBe(0);
    expect(JSON.parse(w.files().config!).catalog).toBe('https://catalog.example/team');
    expect(w.out()).toContain(S.format(S.setup.catalog_hosted, { catalog: 'https://catalog.example/team' }));
  });
});

describe('--dry-run', () => {
  it('prints the plan and changes nothing, in any mode', async () => {
    const w = world();
    expect(await runSetupCommand(['--dry-run'], w.io)).toBe(0);
    expect(w.out()).toContain(S.setup.plan.header);
    expect(w.out()).toContain(S.setup.plan.dry_run);
    expect(readdirSync(w.A)).toEqual([]);
  });

  it('inside Claude Code, the plan leads with "quit this session"', async () => {
    const w = world({ env: { CLAUDECODE: '1' } });
    await runSetupCommand(['--dry-run'], w.io);
    expect(w.out().split('\n')[0]).toBe(S.setup.plan.inside);
  });
});

describe('a refusal from the engine', () => {
  it('someone else\'s skills-catalog server: name_taken, in words, exit 1, nothing changed', async () => {
    const w = world();
    file(join(w.A, '.claude.json'), '{\n  "mcpServers": {\n    "skills-catalog": {"type": "stdio", "command": "/opt/mine"}\n  }\n}\n', 0o600);
    expect(await runSetupCommand(['--yes'], w.io)).toBe(1);
    expect(w.err()).toMatch(/^name_taken: /);
    expect(existsSync(w.H)).toBe(false);
  });
});

describe('a folder catalog on a network or synced folder (F0)', () => {
  it('synced places by path; network file systems by statfs\'s type', () => {
    const local = () => ({ type: 0x1a });
    expect(sharedFolderKind('/Users/x/Library/CloudStorage/Dropbox/cat', local)).toBe('synced');
    expect(sharedFolderKind('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/cat', local)).toBe('synced');
    expect(sharedFolderKind('/home/x/Dropbox/cat', local)).toBe('synced');
    expect(sharedFolderKind('/mnt/share/cat', () => ({ type: 0x6969 }))).toBe('network');
    expect(sharedFolderKind('/home/x/cat', local)).toBeUndefined();
  });

  it('the summary warns, in words, when the catalog answer is one', async () => {
    const w = world();
    expect(await runSetupCommand(['--yes', '--catalog', join(w.dir, 'Dropbox', 'cat')], w.io)).toBe(0);
    expect(w.out()).toContain(S.format(S.setup.catalog_shared_folder, { path: join(w.dir, 'Dropbox', 'cat'), kind: S.setup.shared_folder_kind.synced }));
  });
});
