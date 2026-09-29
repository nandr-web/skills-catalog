// The demo's command-line steps (install in step 3; update, then the person's own --accept in step 8): on the catalog's
// server (qa demo --server) the stand-in runs the catalog's command line as that developer's machine, and the person's
// turn runs in the pane's own terminal while the conductor types their answer; on the core they stay planned. A fake
// command line for the rules (fixtures/demo/fake-cli.mjs); the real one plays in the headless demo with --server.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { Surface } from '../../core/src/index.ts';
import { answer, cliCommand, mcpBackend, serverEnv, type Stage, type Terminal } from '../src/demo/assistant.ts';
import { conduct, type ConductorIo, type StepsFile, type Turn } from '../src/demo/conductor.ts';
import { loadScenes, parseScenes, SCENES_FILE, ScenesError, type Scenes } from '../src/demo/scenes.ts';
import { cleanup, scratch } from './machine.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FAKE_SERVER = [process.execPath, here('fixtures/demo/fake-catalog-server.mjs')];
const FAKE_CLI = [process.execPath, here('fixtures/demo/fake-cli.mjs')];
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const OS_ADDED = ['__CF_USER_TEXT_ENCODING'];
const surface = Surface.load();
// only a whole number above 0 ever reaches process.kill (0 or a negative one would mean a process group)
const alive = (pid: number | undefined) => { if (!(Number.isSafeInteger(pid) && pid! > 0)) return false; try { process.kill(pid!, 0); return true; } catch { return false; } };
const until = async (f: () => boolean, ms = 5000) => { for (let i = 0; i < ms / 25 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); return f(); };
// Each server a test started is stopped, and has exited, before the test's folders are removed: close() only signals it,
// and a server still starting writes into the developer's folder (its SKILLS_HOME) while cleanup deletes it. (vitest runs
// afterEach before onTestFinished, so the stop has to be here, not in a hook of the test's own.) One that hasn't exited
// `ms` after close() is killed (SIGKILL) and still fails the test: a hang fails fast and leaves nothing running.
const servers: ReturnType<typeof mcpBackend>[] = [];
const stop = async (b: ReturnType<typeof mcpBackend>, ms = 5000) => {
  b.close();
  const pid = b.pid();
  if (!(Number.isSafeInteger(pid) && pid! > 0) || (await until(() => !alive(pid), ms))) return true;
  b.kill('SIGKILL');   // through the server's own handle, which skips a child already seen to exit: never a reused pid
  await until(() => !alive(pid), ms);
  return false;
};
afterEach(async () => {
  const stopped = await Promise.all(servers.splice(0).map((b) => stop(b)));
  cleanup();
  expect(stopped, 'every server the test started has exited').not.toContain(false);
});

const settings = (root: string, who: string) => ({ root, who, catalog: pathToFileURL(join(root, 'catalog')).href, activityLog: join(root, 'demo', 'activity.log') });
const cliCalls = (root: string, who: string) => {
  const f = join(serverEnv(settings(root, who)).SKILLS_HOME, 'cli-calls.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)) : [];
};

function sandbox() {
  const root = scratch('qa-demo-cli-');
  for (const d of ['catalog', 'demo', 'work/bob', 'work/ana']) mkdirSync(join(root, d), { recursive: true });
  return root;
}

function stage(scenes: Scenes, root: string, who: string, terminal?: Terminal) {
  const pane = { text: '' };
  const backend = mcpBackend({ command: FAKE_SERVER, cli: FAKE_CLI, ...settings(root, who), surface, ...(terminal ? { terminal } : {}) });
  servers.push(backend);
  const st: Stage = { who, scenes, backend, surface, out: (s) => { pane.text += s; }, demoDir: join(root, 'demo'), pace: 0 };
  return { st, pane, backend };
}

describe('the scene file: the command line steps', () => {
  it('step 3 installs and step 8 updates, then the person accepts in their own pane, typing y at the question', () => {
    const s = loadScenes(SCENES_FILE);
    const step = (id: number) => s.steps.find((x) => x.id === id)!;
    expect(step(3).asks[1]!.calls).toEqual([{ op: 'install', name: 'release-note-draft' }]);
    expect(step(3).expect_server).toEqual({ bob: ['Installed release-note-draft v1'], log: ['installed'] });
    expect(step(8).asks.map((a) => a.calls)).toEqual([[{ op: 'update' }], [{ op: 'accept', name: 'release-note-draft' }]]);
    expect(step(8).asks[1]).toMatchObject({ say: 'skills-catalog update release-note-draft --accept', then: [{ type: 'y', after: 'Take it? (y/N)' }] });
    expect(step(8).expect).toEqual({});
  });

  it('refuses a bad then, an expect_server naming no pane, and command-line ops with missing or extra fields', () => {
    const doc = parse(readFileSync(SCENES_FILE, 'utf8'));
    const bad = structuredClone(doc);
    bad.steps[7].asks[1].then = [{ type: 'y' }];
    bad.steps[7].expect_server.nobody = ['x'];
    bad.steps[2].asks[1].calls = [{ op: 'install' }];
    bad.steps[7].asks[0].calls = [{ op: 'update', name: 'x' }];
    let err: unknown;
    try {
      parseScenes(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScenesError);
    const lines = (err as Error).message.split('\n');
    expect(lines).toEqual(expect.arrayContaining([
      'step 8, ask 2: then must be a list of {type, after}, each non-empty text',
      'step 8: expect_server names nobody, which is not a developer, steps or log',
      'step 3, ask 2, call 1: install needs name (text)',
      'step 8, ask 1, call 1: unknown key name',
    ]));
  });
});

describe('the command line, from the server command', () => {
  it('is the same words less mcp, with node started with its experimental warning off', () => {
    expect(cliCommand(['/usr/bin/node', '/x/client/main.ts', 'mcp'])).toEqual(['/usr/bin/node', '--disable-warning=ExperimentalWarning', '/x/client/main.ts']);
    expect(cliCommand(['/usr/bin/node', '--disable-warning=ExperimentalWarning', '/x/main.ts', 'mcp'])).toEqual(['/usr/bin/node', '--disable-warning=ExperimentalWarning', '/x/main.ts']);
    expect(cliCommand(['/opt/bin/skills-catalog', 'mcp'])).toEqual(['/opt/bin/skills-catalog']);
  });
});

describe('the stand-in on the server runs the command line as the developer', () => {
  const scenes = loadScenes(SCENES_FILE);

  it("install and update: piped, with that developer's settings and folder, shown behind the gutter as the command", async () => {
    const root = sandbox();
    const { st, pane } = stage(scenes, root, 'bob');
    expect((await answer(st, 'install it')).ok).toBe(true);
    expect((await answer(st, 'update my skills')).ok).toBe(true);
    const text = plain(pane.text);
    expect(text).toContain(`● ${surface.cli} install  release-note-draft`);
    expect(text).toContain('  │ fake cli: install release-note-draft');
    expect(text).toContain(`● ${surface.cli} update`);
    expect(text).toContain('  │ fake cli: update');
    const runs = cliCalls(root, 'bob');
    expect(runs.map((r) => r.args)).toEqual([['install', 'release-note-draft'], ['update']]);
    for (const r of runs) {
      expect(r.env.filter((k: string) => !OS_ADDED.includes(k))).toEqual(Object.keys(serverEnv(settings(root, 'bob'))).sort());
      expect(r.cwd).toBe(join(root, 'work', 'bob'));
      expect(r.tty).toBe(false);
    }
  });

  it("a refusal (exit 1) shows its first line in orange; the stand-in writes no log line (the command line logs itself)", async () => {
    const root = sandbox();
    const bad = structuredClone(scenes);
    bad.steps[2]!.asks[1]!.calls = [{ op: 'install', name: 'fails' }];
    const { st, pane } = stage(bad, root, 'bob');
    expect((await answer(st, 'install it')).ok).toBe(true);
    expect(pane.text.split('\n').find((l) => l.includes('fake cli: install fails'))).toContain('\x1b[38;5;208m');
    expect(existsSync(join(root, 'demo', 'activity.log'))).toBe(false);
  });

  it("the person's --accept runs in the pane's own terminal: the stand-in lets go of it, shows nothing itself, takes it back", async () => {
    const root = sandbox();
    const lent: string[] = [];
    const { st, pane } = stage(scenes, root, 'bob', { pause: () => lent.push('pause'), resume: () => lent.push('resume') });
    const before = pane.text;
    expect((await answer(st, 'skills-catalog update release-note-draft --accept')).ok).toBe(true);
    expect(lent).toEqual(['pause', 'resume']);
    expect(pane.text).toBe(before);   // no call line and no gutter: the command line wrote to the pane itself
    expect(cliCalls(root, 'bob').map((r) => r.args)).toEqual([['update', 'release-note-draft', '--accept']]);
  });

  it('without a terminal (a test, a pipe), --accept runs piped: the command line says the person must run it', async () => {
    const root = sandbox();
    const { st, pane } = stage(scenes, root, 'bob');
    expect((await answer(st, 'skills-catalog update release-note-draft --accept')).ok).toBe(true);
    expect(plain(pane.text)).toContain('  │ fake cli: update release-note-draft --accept');
    expect(plain(pane.text)).not.toContain('●');
  });
});

describe("a test's server is gone before its folder is removed", () => {
  let last: { pid: number; root: string } | undefined;

  it('a test that ends while its server is still starting', () => {
    const root = sandbox();
    const { backend } = stage(loadScenes(SCENES_FILE), root, 'bob');
    last = { pid: backend.pid()!, root };
    expect(alive(last.pid)).toBe(true);
  });

  it('after it, that server has exited and its folder is removed, nothing left behind', () => {
    expect(last).toBeDefined();
    expect(Number.isSafeInteger(last!.pid) && last!.pid > 0, 'a real pid, never 0 or undefined').toBe(true);
    let err: unknown;
    try {
      process.kill(last!.pid, 0);
    } catch (e) {
      err = e;
    }
    expect((err as NodeJS.ErrnoException | undefined)?.code).toBe('ESRCH');
    expect(existsSync(last!.root)).toBe(false);
  });

  it('a server that outlives close() is killed (SIGKILL) and fails the test: nothing is left running', async () => {
    const root = sandbox();
    // a server that ignores the SIGTERM close() sends, and says so (in its own folder, SKILLS_HOME) once it does
    const deaf = "const fs = require('node:fs'); process.on('SIGTERM', () => {}); fs.mkdirSync(process.env.SKILLS_HOME, { recursive: true }); fs.writeFileSync(process.env.SKILLS_HOME + '/deaf', ''); setInterval(() => {}, 1000);";
    const backend = mcpBackend({ command: [process.execPath, '-e', deaf], cli: FAKE_CLI, ...settings(root, 'bob'), surface });
    servers.push(backend);   // stopped by afterEach too, should this test fail before its own stop
    const pid = backend.pid();
    expect(alive(pid), 'the server started').toBe(true);
    expect(await until(() => existsSync(join(serverEnv(settings(root, 'bob')).SKILLS_HOME, 'deaf')), 3000), 'the server ignores SIGTERM').toBe(true);
    expect(await stop(backend, 200)).toBe(false);
    expect(alive(pid)).toBe(false);
  });
});

// The conductor with fake panes: an ask that asks the person a question, answered once it shows.
type Say = (who: string, text: string, w: W) => void;
type W = { io: ConductorIo; panes: Record<string, string>; turns: Turn[]; typed: string[] };
function world(say: Say): W {
  const w: W = {
    panes: { ana: 'ana\n› ', bob: 'bob\n› ', steps: '', log: '' }, turns: [], typed: [],
    io: {
      async type(who, text) { w.typed.push(`${who}: ${text}`); w.panes[who] += `${text}\n`; say(who, text, w); },
      capture: (p) => w.panes[p]!,
      turns: () => [...w.turns],
      control: () => [],
      writeSteps(_s: StepsFile) {},
      async sleep() { await new Promise((r) => setImmediate(r)); },
    },
  };
  return w;
}
const turn = (who: string, say: string): Turn => ({ who, say, step: 8, ok: true, at: '' });
const step8 = (): Scenes => { const s = loadScenes(SCENES_FILE); s.steps = [s.steps.find((x) => x.id === 8)!]; return s; };

describe('the conductor, for a step that asks the person', () => {
  it("types the person's y once the question shows, then waits for the turn; with the server, expect_server counts", async () => {
    const w = world((who, text, w) => {
      if (text === 'update my skills') { w.panes[who] += '● skills-catalog update\n  │ was NOT installed\n› '; w.panes.log += 'held: needs an OK\n'; w.turns.push(turn(who, text)); }
      else if (text.endsWith('--accept')) w.panes[who] += 'waiting for your OK\nTake it? (y/N) ';
      else if (text === 'y') { w.panes[who] += 'Took the held update\n› '; w.panes.log += 'taken, with an OK\n'; w.turns.push(turn(who, 'skills-catalog update release-note-draft --accept')); }
    });
    const r = await conduct(step8(), w.io, { mode: 'auto', pace: 0, attached: false, server: true, settleMs: 200 });
    expect(w.typed).toEqual(['bob: update my skills', 'bob: skills-catalog update release-note-draft --accept', 'bob: y']);
    expect(r.steps[0]).toMatchObject({ state: 'seen' });
  });

  it('a question that never shows is never answered: the turn ends the wait (the step is planned on the core)', async () => {
    const w = world((who, text, w) => { w.panes[who] += '  ● planned\n› '; w.turns.push(turn(who, text)); });
    const r = await conduct(step8(), w.io, { mode: 'auto', pace: 0, attached: false, settleMs: 200 });
    expect(w.typed).toEqual(['bob: update my skills', 'bob: skills-catalog update release-note-draft --accept']);
    expect(r.steps[0]).toMatchObject({ state: 'planned' });
  });

  it("with the server, a missing expect_server text is missed", async () => {
    const w = world((who, text, w) => { w.panes[who] += '› '; w.turns.push(turn(who, text)); });
    const r = await conduct(step8(), w.io, { mode: 'auto', pace: 0, attached: false, server: true, settleMs: 100, turnTimeoutMs: 500 });
    expect(r.steps[0]!.state).toBe('missed');
    expect(r.steps[0]!.missing).toEqual(expect.arrayContaining(['bob: Take it? (y/N)', 'log: taken, with an OK']));
  });
});
