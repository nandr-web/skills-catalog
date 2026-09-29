// The stand-in on the catalog's MCP server (the demo plan, piece C): one server per developer, each its own machine in
// the sandbox, started at the first ask with those settings and nothing else; each catalog step is a tool call, printed
// with the tool's name and the server's own words; publish is its two calls (the preview, then the confirm), with the
// person's yes between them; the server, not the stand-in, writes activity.log. A fake server for the rules
// (fixtures/demo/fake-catalog-server.mjs), and the real one when DEMO_MCP_SERVER holds its command.
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { Surface } from '../../core/src/index.ts';
import { answer, mcpBackend, serverEnv, toolName, type Stage, type Turn } from '../src/demo/assistant.ts';
import { serverCommand } from '../src/demo/director.ts';
import { CLI_OPS, loadScenes, SCENES_FILE, SKILLS_DIR, type Scenes } from '../src/demo/scenes.ts';
import { cleanup, scratch } from './machine.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FAKE = [process.execPath, here('fixtures/demo/fake-catalog-server.mjs')];
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, '');
const ORANGE = '\x1b[38;5;208m';
const orange = (pane: string) => pane.split('\n').filter((l) => l.includes(ORANGE)).map(plain);
// macOS itself adds __CF_USER_TEXT_ENCODING (the text encoding id) to every process it starts; it is no secret.
const OS_ADDED = ['__CF_USER_TEXT_ENCODING'];
const surface = Surface.load();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (f: () => boolean, ms = 5000) => { for (let i = 0; i < ms / 25 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); return f(); };
const within = (p: string, dir: string) => { const r = relative(dir, p); return !!r && !r.startsWith('..') && !isAbsolute(r); };
afterEach(() => cleanup());

/** A sandbox-like folder: each developer's skills in work/<who>/skills (as the director copies them), the catalog, demo/. */
function sandbox(scenes: Scenes) {
  const root = scratch('qa-demo-mcp-');
  for (const d of scenes.developers) {
    mkdirSync(join(root, 'work', d.id, 'skills'), { recursive: true });
    for (const f of d.skills) cpSync(join(SKILLS_DIR, f), join(root, 'work', d.id, 'skills', f), { recursive: true });
  }
  mkdirSync(join(root, 'catalog'));
  mkdirSync(join(root, 'demo'));
  return root;
}
const settings = (root: string, who: string) => ({ root, who, catalog: pathToFileURL(join(root, 'catalog')).href, activityLog: join(root, 'demo', 'activity.log') });
const skillsHome = (root: string, who: string) => serverEnv(settings(root, who)).SKILLS_HOME;
const calls = (root: string, who: string) => {
  const f = join(skillsHome(root, who), 'calls.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
};
const serverPid = (root: string, who: string) => { const f = join(skillsHome(root, who), 'pid'); return existsSync(f) ? Number(readFileSync(f, 'utf8')) : undefined; };
const logOf = (root: string) => (existsSync(join(root, 'demo', 'activity.log')) ? readFileSync(join(root, 'demo', 'activity.log'), 'utf8') : '');

/** A developer's stage on an MCP backend; its server is stopped when the test ends, however it ends. */
function stage(scenes: Scenes, root: string, who: string, command = FAKE) {
  const pane = { text: '' };
  const backend = mcpBackend({ command, ...settings(root, who), surface });
  onTestFinished(() => backend.close());
  const st: Stage = { who, scenes, backend, surface, out: (s) => { pane.text += s; }, demoDir: join(root, 'demo'), pace: 0 };
  return { st, pane, backend };
}

describe('the server command (qa demo --server, DEMO_MCP for the panes)', () => {
  it('is split at spaces into its words, with no shell; its first word must be an absolute path', () => {
    expect(serverCommand('/usr/bin/node /x/client/server.ts mcp')).toEqual(['/usr/bin/node', '/x/client/server.ts', 'mcp']);
    expect(serverCommand('  /a   b\tc ')).toEqual(['/a', 'b', 'c']);
    expect(serverCommand('/a "b c" $HOME;x')).toEqual(['/a', '"b', 'c"', '$HOME;x']);   // quotes, $ and ; are just characters
    for (const bad of ['node cli.ts mcp', './node cli.ts', '~/node cli.ts']) expect(() => serverCommand(bad), bad).toThrow(/absolute path/);
    expect(() => serverCommand('   ')).toThrow(/empty/);
  });
});

describe("each developer's server settings", () => {
  const root = '/sandbox/run';

  it("are exactly these: a PATH of the system's folders, the developer's own machine in the sandbox, the shared catalog, the demo's log", () => {
    const env = serverEnv(settings(root, 'ana'));
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH', 'SKILLS_ACTIVITY_LOG', 'SKILLS_AS', 'SKILLS_ASSISTANT_HOME', 'SKILLS_CATALOG', 'SKILLS_HOME']);
    // inside a run, the run's id too (qa run finds a leftover server by it); anything that isn't a run id is left out
    expect(serverEnv({ ...settings(root, 'ana'), runId: '20260929T001234Z-1a2b3c4d' }).QA_RUN_ID).toBe('20260929T001234Z-1a2b3c4d');
    expect(serverEnv({ ...settings(root, 'ana'), runId: 'x; rm -rf' })).not.toHaveProperty('QA_RUN_ID');
    expect(env).toMatchObject({
      PATH: '/usr/bin:/bin', HOME: join(root, 'home', 'ana'), SKILLS_AS: 'ana',
      SKILLS_CATALOG: pathToFileURL(join(root, 'catalog')).href, SKILLS_ACTIVITY_LOG: join(root, 'demo', 'activity.log'),
    });
    // skills install to SKILLS_ASSISTANT_HOME's .claude/skills (the product adds that): it is ana's own home, as HOME is;
    // the client's folder is in it, in the sandbox
    expect(env.SKILLS_ASSISTANT_HOME).toBe(env.HOME);
    for (const k of ['SKILLS_HOME']) {
      expect(env[k], k).toBeTruthy();
      expect(within(env[k]!, env.HOME!), k).toBe(true);
      expect(within(env[k]!, root), k).toBe(true);
    }
  });

  it("ana's and bob's are two machines: every folder of theirs differs; only the catalog (and the demo's log) is shared", () => {
    const ana = serverEnv(settings(root, 'ana')), bob = serverEnv(settings(root, 'bob'));
    for (const k of ['HOME', 'SKILLS_HOME', 'SKILLS_ASSISTANT_HOME', 'SKILLS_AS']) {
      expect(ana[k], k).not.toBe(bob[k]);
      if (k !== 'SKILLS_AS') expect(within(ana[k]!, bob.HOME!) || within(bob[k]!, ana.HOME!), k).toBe(false);
    }
    expect(Object.keys(ana).filter((k) => ana[k] === bob[k]).sort()).toEqual(['PATH', 'SKILLS_ACTIVITY_LOG', 'SKILLS_CATALOG']);
  });

  it('refuses a catalog, a log or a developer name that would put the server outside the sandbox', () => {
    const ok = settings(root, 'ana');
    expect(() => serverEnv({ ...ok, catalog: pathToFileURL('/elsewhere/catalog').href })).toThrow(/catalog .* sandbox/);
    expect(() => serverEnv({ ...ok, catalog: 'https://catalog.example.com' })).toThrow(/catalog .* sandbox/);
    expect(() => serverEnv({ ...ok, activityLog: '/tmp/activity.log' })).toThrow(/log .* sandbox/);
    for (const who of ['../mallory', '', 'a/b', '.']) expect(() => serverEnv({ ...ok, who }), who).toThrow(/developer/);
  });
});

describe('the stand-in on an MCP server (a fake one)', () => {
  const scenes = loadScenes(SCENES_FILE);

  it("its server gets exactly the developer's settings, and stops when the stand-in closes it", async () => {
    const root = sandbox(scenes);
    const { st, backend } = stage(scenes, root, 'bob');
    expect((await answer(st, 'find me a skill for release changelogs')).ok).toBe(true);
    const env = JSON.parse(readFileSync(join(skillsHome(root, 'bob'), 'env.json'), 'utf8'));
    for (const k of OS_ADDED) delete env[k];
    expect(env).toEqual(serverEnv(settings(root, 'bob')));
    const pid = serverPid(root, 'bob')!;
    expect(backend.pid()).toBe(pid);
    expect(alive(pid)).toBe(true);
    backend.close();
    expect(await until(() => !alive(pid))).toBe(true);
  });

  it("each catalog step is one tool call, named as the surface names it, with the server's own words under it", async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'bob');
    await answer(st, 'find me a skill for release changelogs');
    await answer(st, 'what changed in release-note-draft v2?');
    expect(calls(root, 'bob')).toEqual([
      { name: surface.names.search, arguments: { query: 'changelog for a release' } },
      { name: surface.names.versions, arguments: { name: 'release-note-draft' } },
      { name: surface.names.diff, arguments: { name: 'release-note-draft', from: 1, to: 2 } },
    ]);
    const text = plain(pane.text);
    expect(text).toContain(`● ${surface.names.search}  "changelog for a release"\n  │ Shared catalog: 1 of 2 skills match "changelog for a release" (fake).\n  │ - release-note-draft (v1, ana; tags: release, docs): Write release notes.\n  │ (Acting as bob, for demo purposes.)\n`);
    expect(text).toContain(`● ${surface.names.versions}  release-note-draft\n  │ release-note-draft: 2 version(s), latest v2. Newest first:\n`);
    expect(text).toContain(`● ${surface.names.diff}  release-note-draft v1 → v2\n  │ release-note-draft v1 -> v2: 3 file(s) changed.`);
    expect(pane.text).toContain(`\x1b[32m● ${surface.names.search}  "changelog for a release"\x1b[0m\n`);
  });

  it("publish is two calls, both shown: the preview, the person's yes, then the confirm with the preview's value", async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'ana');
    expect(await answer(st, 'publish my skills, release-note-draft and sql-migrations')).toMatchObject({ step: 2, ok: true });
    const folder = (f: string) => join(root, 'work', 'ana', 'skills', f);
    expect(calls(root, 'ana')).toEqual([
      { name: surface.names.publish, arguments: { folder: folder('release-note-draft-v1'), message: 'first version' } },
      { name: surface.names.publish, arguments: { folder: folder('release-note-draft-v1'), message: 'first version', confirm: 'tok-release-note-draft-v1' } },
      { name: surface.names.publish, arguments: { folder: folder('sql-migrations'), message: 'first version' } },
      { name: surface.names.publish, arguments: { folder: folder('sql-migrations'), message: 'first version', confirm: 'tok-sql-migrations' } },
    ]);
    const text = plain(pane.text);
    expect(text).toContain(`● ${surface.names.publish}  release-note-draft\n  │ Preview only: nothing was published. release-note-draft would become v1`);
    expect(text).toContain(`  │ (Acting as ana, for demo purposes.)\n  (ana says yes to publishing)\n● ${surface.names.publish}  release-note-draft (confirm)\n  │ Published release-note-draft v1 to the shared catalog (fingerprint checked).\n`);
    expect(text.match(/says yes/g)).toHaveLength(2);
    expect(pane.text).toContain('\x1b[2m  (ana says yes to publishing)\x1b[0m\n');   // dimmed: the stand-in's words, not the product's
    expect(orange(pane.text)).toEqual([]);
  });

  for (const [mode, where] of [['--step2-values', 'in its text'], ['--structured', 'in its structured content']] as const) {
    it(`when the confirm call needs more of the preview's values (name, version, files, flags), each goes in exactly as the preview gives it (${where})`, async () => {
      const root = sandbox(scenes);
      const { st, pane } = stage(scenes, root, 'ana', [...FAKE, mode]);
      expect(await answer(st, 'publish v2 of release-note-draft, it adds a script')).toMatchObject({ step: 4, ok: true });
      const folder = join(root, 'work', 'ana', 'skills', 'release-note-draft-v2'), message = 'add a script that lists merged PRs';
      expect(calls(root, 'ana')).toEqual([
        { name: surface.names.publish, arguments: { folder, message } },
        { name: surface.names.publish, arguments: { folder, message, confirm: 'tok-release-note-draft-v2', name: 'release-note-draft', version: 1, files: 2, flags: ['runnable_file'] } },
      ]);
      expect(plain(pane.text)).toContain('  │ Published release-note-draft v1 to the shared catalog (fingerprint checked).\n');
    });
  }

  it('a refusal (isError) shows orange, and a refused preview is never confirmed', async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'bob');
    expect(await answer(st, 'publish my fix to release-note-draft')).toMatchObject({ step: 6, ok: true });   // a refusal is the catalog's answer
    expect(calls(root, 'bob')).toHaveLength(1);
    expect(plain(pane.text)).not.toContain('says yes');
    expect(orange(pane.text)).toEqual(['  │ not_owner: release-note-draft belongs to ana; only they publish new versions of it, so nothing was published.']);
  });

  it('"Can run something new on this machine: yes" shows orange, with the files listed under it that can run; nothing else does', async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'bob');
    await answer(st, 'what changed in release-note-draft v2?');
    expect(orange(pane.text)).toEqual([
      '  │ release-note-draft v1 -> v2: 3 file(s) changed. Can run something new on this machine: yes, because it adds scripts/collect.sh, which can run.',
      '  │ - added: scripts/collect.sh (can run)',
      '  │ - added: scripts/lint.py (a script)',
    ]);
  });

  it('the server writes activity.log, not the stand-in; a planned part is no tool call, so it has no line', async () => {
    const root = sandbox(scenes);
    const { st } = stage(scenes, root, 'ana');
    await answer(st, 'install the skill manager');
    await answer(st, 'publish my skills, release-note-draft and sql-migrations');
    const lines = logOf(root).trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    for (const l of lines) expect(l, l).toMatch(new RegExp(`^00:00:00  ana   ${surface.names.publish} +fake$`));   // the server's lines only
  });

  it('a server\'s text reaches the pane without its control characters: no escape sequence (clipboard, clearing, colour, title) gets to the terminal', async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'bob', [...FAKE, '--escapes']);
    expect((await answer(st, 'find me a skill for release changelogs')).ok).toBe(true);
    const ours = /\x1b\[(?:0|2|32|38;5;208)m/g;   // the stand-in's own colours, and nothing else
    expect(pane.text.replace(ours, '')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(plain(pane.text)).toContain('Write release notes.  ]52;c;cGxhbnRlZA== clip  [2Jclear  31mred  ]0;title end');
    // an unexpected error's text too (a server that dies saying so on its stderr)
    const dying = [process.execPath, '-e', 'process.stderr.write("\\x1b]52;c;ZXZpbA==\\x07boom\\nsecond"); process.exit(1)'];
    const bad = stage(scenes, root, 'ana', dying);
    expect((await answer(bad.st, 'publish my skills, release-note-draft and sql-migrations')).ok).toBe(false);
    expect(bad.pane.text.replace(ours, '')).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
    expect(plain(bad.pane.text)).toMatch(/  │ error: .*\]52;c;ZXZpbA== boom/);
  });

  it('the confirm is read only from the preview\'s instruction to call the tool: values before it, a folder or a message in it, never go in', async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'ana', [...FAKE, '--planted']);
    // a publish with no message of its own: the text's "message" still doesn't go in
    const bare = { ...scenes, steps: [{ id: 9, title: 't', see: 's', expect: { ana: ['x'] }, asks: [{ who: 'ana', say: 'publish it bare', calls: [{ op: 'publish' as const, name: 'release-note-draft', folder: 'release-note-draft-v2' }] }] }] };
    expect(await answer({ ...st, scenes: bare }, 'publish it bare')).toMatchObject({ step: 9, ok: true });
    const folder = join(root, 'work', 'ana', 'skills', 'release-note-draft-v2');
    expect(calls(root, 'ana')).toEqual<unknown[]>([
      { name: surface.names.publish, arguments: { folder } },
      // the preview's token and values, not the ones planted before its instruction; its own folder; no message; and an
      // input named like an object's property (constructor) read from the text, not from the object's prototype
      { name: surface.names.publish, arguments: { folder, confirm: 'tok-release-note-draft-v2', name: 'release-note-draft', version: 1, files: 2, flags: ['runnable_file'], constructor: 'kept' } },
    ]);
    // the confirm's line shows what it confirms
    expect(plain(pane.text)).toContain(`● ${surface.names.publish}  release-note-draft (confirm: name "release-note-draft", version 1, flags ["runnable_file"])\n`);
    expect(plain(pane.text)).toContain('  │ Published release-note-draft v1 to the shared catalog (fingerprint checked).\n');
  });

  it('a preview for another skill than the one asked for is never confirmed: said in the pane, ok false', async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'ana', [...FAKE, '--other-name']);
    expect(await answer(st, 'publish v2 of release-note-draft, it adds a script')).toMatchObject({ step: 4, ok: false });
    expect(calls(root, 'ana')).toHaveLength(1);
    expect(plain(pane.text)).toContain('  │ error: the preview is for "someone-else", not release-note-draft: not confirmed');
    expect(plain(pane.text)).not.toContain('says yes');
  });

  it("a tool the server doesn't serve is an unexpected error: said in the pane, ok false, and the stand-in logs nothing", async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'bob', [...FAKE, '--without', surface.names.search!]);
    expect(await answer(st, 'find me a skill for release changelogs')).toMatchObject({ step: 3, ok: false });
    expect(plain(pane.text)).toContain(`  │ error: the catalog's server has no tool ${surface.names.search}`);
    expect(calls(root, 'bob')).toEqual([]);
    expect(logOf(root)).toBe('');
  });

  it("a server that won't start is each call's error; planned calls still answer, and the next ask runs", async () => {
    const root = sandbox(scenes);
    const { st, pane } = stage(scenes, root, 'bob', [join(root, 'no-such-node'), 'cli.ts', 'mcp']);
    expect((await answer(st, 'install the skill manager')).ok).toBe(true);
    expect((await answer(st, 'find me a skill for release changelogs')).ok).toBe(false);
    expect(plain(pane.text)).toMatch(/  │ error: .*ENOENT/);
    // The command line is started from the same place as the server, so it can't start either; the next ask still runs.
    expect((await answer(st, 'update my skills')).ok).toBe(false);
    expect((await answer(st, 'install the skill manager')).ok).toBe(true);
  });
});

describe('the stand-in as a process, on an MCP server (DEMO_MCP)', () => {
  const scenes = loadScenes(SCENES_FILE);
  const started: { child: ChildProcess; root: string }[] = [];
  afterEach(() => {
    for (const { child, root } of started.splice(0)) {
      child.kill('SIGKILL');
      const pid = serverPid(root, 'bob');
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  });

  function standIn(root: string, demoMcp: string) {
    const child = spawn(process.execPath, [here('../src/demo/assistant.ts'), '--as', 'bob'], {
      cwd: join(root, 'work', 'bob'), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SKILLS_CATALOG: pathToFileURL(join(root, 'catalog')).href, QA_SANDBOX: root, DEMO_PACE: '0', DEMO_SCENES: SCENES_FILE, SKILLS_ACTIVITY_LOG: join(root, 'demo', 'activity.log'), DEMO_MCP: demoMcp },
    });
    started.push({ child, root });
    const p = { child, out: '', err: '', exit: new Promise<number | null>((ok) => child.on('exit', (code, sig) => ok(code ?? (sig ? -1 : null)))) };
    child.stdout!.on('data', (b) => { p.out += b; });
    child.stderr!.on('data', (b) => { p.err += b; });
    return p;
  }

  for (const ending of ['end of input', 'SIGTERM', 'SIGHUP'] as const) {
    it(`starts its server at the first ask, and stops it when it ends (${ending})`, async () => {
      const root = sandbox(scenes);
      const p = standIn(root, FAKE.join(' '));
      expect(await until(() => p.out.includes('› '))).toBe(true);
      expect(plain(p.out)).toContain('over its MCP server');
      await new Promise((r) => setTimeout(r, 200));
      expect(serverPid(root, 'bob')).toBeUndefined();   // not before the first ask
      p.child.stdin!.write('find me a skill for release changelogs\n');
      expect(await until(() => existsSync(join(root, 'demo', 'turns.jsonl')))).toBe(true);
      expect(plain(p.out)).toContain('  │ Shared catalog: 1 of 2 skills match');
      const pid = serverPid(root, 'bob')!;
      expect(alive(pid)).toBe(true);
      if (ending === 'end of input') p.child.stdin!.end(); else p.child.kill(ending);
      await p.exit;
      expect(await until(() => !alive(pid)), `server ${pid} after ${ending}`).toBe(true);
      expect(p.err).toBe('');
    }, 30_000);
  }

  it("refuses a DEMO_MCP whose first word isn't an absolute path (exit 3, one line)", async () => {
    const root = sandbox(scenes);
    const p = standIn(root, 'node cli.ts mcp');
    expect(await p.exit).toBe(3);
    expect(p.err).toMatch(/^DEMO_MCP: .*absolute path.*\n$/);
  });
});

// The real server: DEMO_MCP_SERVER="<absolute path to node> <the client's command line> mcp". It plays the whole scene file, so the scene
// can't promise words the server doesn't say.
const REAL = process.env.DEMO_MCP_SERVER;
const noReal = REAL ? '' : "DEMO_MCP_SERVER isn't set to the catalog MCP server's command";
describe.skipIf(!!noReal)(`the stand-in on the real catalog MCP server${noReal ? ` (skipped: ${noReal})` : ''}`, () => {
  it("plays all eight steps: every developer pane's expected text shows during its step, and the server writes the log", async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const command = serverCommand(REAL!);
    const devs = Object.fromEntries(scenes.developers.map((d) => [d.id, stage(scenes, root, d.id, command)]));
    const turns: Turn[] = [];
    for (const step of scenes.steps) {
      const before: Record<string, number> = { ...Object.fromEntries(Object.entries(devs).map(([who, d]) => [who, d.pane.text.length])), log: logOf(root).length };
      for (const ask of step.asks) turns.push(await answer(devs[ask.who]!.st, ask.say));
      for (const [pane, strings] of Object.entries(step.expect)) {
        if (pane === 'steps') continue;   // the steps view draws that pane
        const shown = pane === 'log' ? logOf(root).slice(before.log) : plain(devs[pane]!.pane.text.slice(before[pane]!));
        for (const s of strings) expect.soft(shown, `step ${step.id}, ${pane}: ${s}`).toContain(s);   // every missing text, not just the first
      }
    }
    expect(turns.map((t) => [t.who, t.step, t.ok])).toEqual(scenes.steps.flatMap((s) => s.asks.map((a) => [a.who, s.id, true])));

    // the log: the server's line for each tool call (a publish is its preview and its confirm, unless the preview is
    // refused: bob's, in step 6) and the command line's for each of its ops, in order, in columns, with no colour; none
    // for a planned part (no call happened), nor for the person's --accept, which here, piped, nobody answers
    const log = logOf(root);
    const lines = log.trimEnd().split('\n');
    const expected = scenes.steps.flatMap((s) => s.asks.flatMap((a) => a.calls.flatMap((c) => {
      if ('planned' in c || c.op === 'accept') return [];
      if (CLI_OPS.includes(c.op)) return [[a.who, c.op, 'server']];
      const tool = toolName(surface, c.op);
      return c.op === 'publish' && a.who === 'ana' ? [[a.who, tool, 'server'], [a.who, tool, 'server']] : [[a.who, tool, 'server']];
    })));
    expect(lines.map((l) => { const m = l.match(/^\d\d:\d\d:\d\d {2}(\S+) +(\S+(?: setup)?) {2,}(.*)$/); return m ? [m[1], m[2], /^planned +-$/.test(m[3]!) ? 'planned' : 'server'] : l; })).toEqual(expected);
    expect(log).not.toMatch(/\x1b/);
    const typed = [
      ...scenes.steps.flatMap((s) => s.asks.map((a) => a.say)),
      ...scenes.steps.flatMap((s) => s.asks.flatMap((a) => a.calls.flatMap((c) => ('message' in c && c.message ? [c.message] : [])))),
      'graphql', 'changelog', 'Write release notes', root,
    ];
    for (const t of typed) expect(log.toLowerCase(), t).not.toContain(t.toLowerCase());

    // each developer's server is stopped at the end
    const pids = Object.values(devs).map((d) => d.backend.pid()!);
    for (const d of Object.values(devs)) d.backend.close();
    for (const pid of pids) expect(await until(() => !alive(pid)), `server ${pid}`).toBe(true);
  }, 120_000);
});
