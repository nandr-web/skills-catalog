// The README's install, followed word for word (skill-readme-run; the review's critical gap UC-01: "publish my skill in
// ./my-skill" failed after the README install). In a fresh home: each line of README.md's "Or run it yourself" block is
// run as written, with three stand-ins a test needs, each checked against the line first: the clone copies this working
// tree (no network), `npm ci --ignore-scripts` copies this tree's installed packages (no network), and setup takes every
// default with --yes, as a person pressing Enter at each question would. Then Claude Code's part, simulated: the MCP
// server is started exactly as the entry setup wrote it, and the README's first prompts run over it: publish ./my-skill
// (preview, then the person's yes), find it, and install it as a second developer. The terminal command setup added runs.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { Words } from '@skills-catalog/core';
import { processEnv, sandbox } from '@skills-catalog/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { skillMd } from './seed.ts';
import { childEnv, startServer, type Place, type Server } from './server.ts';

vi.setConfig({ testTimeout: 120_000 });

const S = Words.load();
const ROOT = realpathSync(join(import.meta.dirname, '..', '..'));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const URL_ = 'https://github.com/nandr-web/skills-catalog.git';
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

/** The shell block under "### Or run it yourself", line by line. */
function installLines(): string[] {
  const at = README.indexOf('### Or run it yourself');
  expect(at, 'README.md has an "Or run it yourself" section').toBeGreaterThan(0);
  const m = /```sh\n([\s\S]*?)```/.exec(README.slice(at));
  return m![1]!.trim().split('\n');
}

/** This working tree's files (tracked, and new ones not ignored), as a clone would have them once committed. */
function tracked(): string[] {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8', env: processEnv(sandbox()) });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout.split('\0').filter((f) => f && existsSync(join(ROOT, f)));
}

// The runner's temp folder is where sandboxes go; setup refuses to point Claude Code at code under /tmp or /var/tmp
// (they get cleaned), which is right for a person. Where the temp folder is /tmp (Linux), this test's sandbox goes in
// the person's runtime folder instead (XDG_RUNTIME_DIR, /run/user/<uid>: private, not cleaned while they're logged in);
// with neither, it can't run, and says so.
const isUnderTmp = (p: string) =>
  ['/tmp', '/var/tmp'].some((t) => {
    try {
      return realpathSync(p).startsWith(realpathSync(t) + '/');
    } catch {
      return false;
    }
  });
function installSandbox(): string | undefined {
  const s = sandbox();
  if (!isUnderTmp(s)) return s;
  const runtime = process.env['XDG_RUNTIME_DIR'];
  if (!runtime || isUnderTmp(runtime)) return undefined;
  // The core's sandbox, made in the runtime folder (it reads the temp folder from TMPDIR), so its fail-safe and its
  // clean-up both know it.
  const was = process.env['TMPDIR'];
  process.env['TMPDIR'] = runtime;
  try {
    return sandbox();
  } finally {
    if (was === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = was;
  }
}
const underTmp = isUnderTmp(tmpdir()) && (!process.env['XDG_RUNTIME_DIR'] || isUnderTmp(process.env['XDG_RUNTIME_DIR']));

describe('the README install, word for word', () => {
  it.skipIf(underTmp)('installs, sets up, and the README\'s first prompts work: publish ./my-skill, find it, install it as a teammate', async () => {
    const dir = installSandbox()!;
    const home = join(dir, 'os-home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // The person's shell: a fresh home, their login, no SKILLS_* setting but the managed-settings stand-in every test sets.
    const env: Record<string, string> = { ...processEnv(dir), HOME: home, USER: 'reviewer', SKILLS_MANAGED_SETTINGS: join(dir, 'managed') };
    let cwd = home;
    const expand = (w: string) => w.replace(/^~(?=\/|$)/, home);
    const run = (argv: string[], o: { input?: string } = {}) => {
      const r = spawnSync(argv[0]!, argv.slice(1), { cwd, env, encoding: 'utf8', input: o.input ?? '' });
      return { code: r.status, out: r.stdout, err: r.stderr };
    };

    for (const line of installLines()) {
      const parts = line.split(' && ');
      for (const part of parts) {
        const w = part.trim().split(/\s+/).map(expand);
        if (w[0] === 'git' && w[1] === 'clone') {
          expect(w.slice(2)).toEqual([URL_, join(home, 'skills-catalog')]);
          for (const f of tracked()) {
            mkdirSync(dirname(join(w[3]!, f)), { recursive: true });
            cpSync(join(ROOT, f), join(w[3]!, f), { verbatimSymlinks: true });
          }
        } else if (w[0] === 'cd') {
          expect(w.length).toBe(2);
          cwd = w[1]!;
        } else if (w[0] === 'npm') {
          expect(w).toEqual(['npm', 'ci', '--ignore-scripts']);
          const pkg = cwd.slice(join(home, 'skills-catalog').length + 1);
          cpSync(join(ROOT, pkg, 'node_modules'), join(cwd, 'node_modules'), { recursive: true, verbatimSymlinks: true });
        } else if (w[0] === 'node' && w[2] === 'setup') {
          expect(w).toEqual(['node', join(home, 'skills-catalog', 'client', 'src', 'cli.ts'), 'setup']);
          const r = run([process.execPath, w[1]!, 'setup', '--yes']);
          expect(r.code, r.out + r.err).toBe(0);
          expect(r.out).toContain(S.format(S.setup.done_me, { me: 'reviewer' }));
        } else {
          throw new Error(`a README install line this test doesn't know how to follow: ${part}`);
        }
      }
    }

    // Claude Code's part: the MCP server, started as setup's entry says, with the environment Claude Code gives it.
    const claude = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    const entry = claude.mcpServers['skills-catalog'] as { command: string; args: string[]; env: Record<string, string> };
    expect(entry.env['SKILLS_AS']).toBeUndefined();
    const skillsHome = join(home, '.skills-catalog');
    const p: Place = { dir, home: skillsHome, catalogDir: join(skillsHome, 'catalog'), catalogUrl: pathToFileURL(join(skillsHome, 'catalog')).href, osHome: home, managed: join(dir, 'managed') };
    const fromClaude = { HOME: home, USER: 'reviewer', ...entry.env };

    // "publish my skill in ./my-skill"
    const mySkill = join(home, 'skills-catalog', 'my-skill');
    mkdirSync(mySkill, { recursive: true });
    writeFileSync(join(mySkill, 'SKILL.md'), skillMd('my-skill', 'Drafts the team\'s notes.', 'Write the notes.\n'));
    const ana = startServer(p, fromClaude, { command: entry.command, args: entry.args });
    servers.push(ana);
    await ana.initialize();
    const P = S.names['publish']!;
    const preview = await ana.call(P, { folder: mySkill });
    expect(preview.isError, preview.content[0]!.text).toBeFalsy();
    expect(preview.content[0]!.text).toContain(S.format(S.word('acting_as'), { developer: 'reviewer' }));
    const m = /confirm "([^"]*)", name "([^"]*)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(preview.content[0]!.text)!;
    const done = await ana.call(P, { folder: mySkill, confirm: m[1], name: m[2], version: Number(m[3]), files: Number(m[4]), flags: JSON.parse(m[5]!) });
    expect(done.isError, done.content[0]!.text).toBeFalsy();
    expect(done.content[0]!.text).toContain(S.format(S.word('publish.published'), { name: 'my-skill', version: 1 }));

    // A teammate on the same machine finds it and installs it (another developer: SKILLS_AS, as the README's demo does).
    const bob = startServer(p, { ...fromClaude, SKILLS_AS: 'bob' }, { command: entry.command, args: entry.args });
    servers.push(bob);
    await bob.initialize();
    const found = await bob.call(S.names['search']!, { query: 'team notes' });
    expect(found.content[0]!.text).toContain('my-skill');
    const installed = await bob.call(S.names['install']!, { name: 'my-skill' });
    expect(installed.isError, installed.content[0]!.text).toBeFalsy();
    expect(readFileSync(join(home, '.claude', 'skills', 'my-skill', 'SKILL.md'), 'utf8')).toContain('Write the notes.');

    // The command the product's messages name, in the person's terminal (with setup's folder on PATH, as it says).
    const list = spawnSync(join(home, '.local', 'bin', 'skills-catalog'), ['list'], { cwd: home, encoding: 'utf8', env: childEnv(p, { HOME: home, USER: 'reviewer', PATH: `${join(home, '.local', 'bin')}:${env["PATH"]}` }) });
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain('my-skill');
  });
});
