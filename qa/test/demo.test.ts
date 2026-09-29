// `qa demo` (the one-click demo's harness): its own tmux server inside the run's sandbox, the scene's steps typed into the
// panes and checked, and everything torn down by qa run's machinery. Real tmux (skipped, with the reason, when it's
// missing), fake machines always, a tiny scene file and a fake pane program (test/fixtures/demo/).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, onTestFinished } from 'vitest';
import { checksProcesses, runProcesses } from '../src/check.ts';
import { firstPid, pidFrom } from '../src/pids.ts';
import { signalGroup } from '../src/groups.ts';
import { conduct, joined, stoppedLine, type ConductorIo, type StepsFile, type Turn } from '../src/demo/conductor.ts';
import { loadScenes, type Scenes } from '../src/demo/scenes.ts';
import { renderSteps, type StepsState } from '../src/demo/steps-view.ts';
import { copySkills, DEFAULTS, demoEnding, demoPaths, demoTimeoutMs, leftoverGroups, LOG_NOTE, nodeOk, preflight, repoServer, running, serverCommand } from '../src/demo/director.ts';
import type { RunResult } from '../src/run.ts';
import { batch, buildLayout, configure, literal, markReady, startServer, tmuxAt, tmuxVersion, versionOk, waitForServer, waitForSession, type Tmux } from '../src/demo/tmux.ts';
import { sandboxBase } from '../src/sandbox.ts';
import { cleanup, machine, qaBareSync, qaSpawn, qaSpawnInTerminal, qaSync, scratch, type TestMachine } from './machine.ts';

const servers: { kill: () => void }[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.kill(); cleanup(); });

const fixture = (f: string) => fileURLToPath(new URL(`fixtures/demo/${f}`, import.meta.url));
const TMUX = tmuxVersion();
const noTmux = versionOk(TMUX) ? '' : `tmux 3.2 or later isn't installed (${TMUX ?? 'no tmux on PATH'})`;
// The test's stand-in and steps view; and a client that isn't installed, so the default is the core (no catalog server)
const demoEnv = (scenes = 'scenes.yaml', extra: Record<string, string> = {}) => ({
  DEMO_SCENES: fixture(scenes), DEMO_ASSISTANT: fixture('pane.mjs'), DEMO_STEPS_VIEW: fixture('pane.mjs'), DEMO_CLIENT: scratch('qa-no-client-'), ...extra,
});
// This repository's catalog server, the demo's default once its dependencies are installed
const CLIENT = DEFAULTS.client, ownServer = existsSync(join(CLIENT, 'node_modules'));
const alive = running;
/** How a clean ending reads: where the check lists processes (macOS, Linux) every check ran; elsewhere it says so. */
const NOTHING_LEFT = checksProcesses(process.platform) ? ', nothing left behind' : '; files, settings and ports unchanged; processes not checked on this system yet';
// A whole qa run per test: a ceiling for a busy machine, not a pace (each run ends itself sooner: its turns time out at 30 s).
const RUN_MS = 120_000;

type Box = { left: number; top: number; width: number; height: number };
/** layout.txt: `<title> <left>,<top> <width>x<height>` per pane. */
function layout(text: string): Record<string, Box> {
  return Object.fromEntries(text.trim().split('\n').map((l) => {
    const m = l.match(/^(.*) (\d+),(\d+) (\d+)x(\d+)$/)!;
    return [m[1], { left: +m[2], top: +m[3], width: +m[4], height: +m[5] }];
  }));
}

/** Runs qa demo headless; watches for the tmux socket inside the sandbox while it runs. */
async function demo(m: TestMachine, flags: string[], env: Record<string, string>, during?: (sandbox: string, p: ChildProcess) => void) {
  const out = scratch('qa-demo-out-');
  const p = qaSpawn(m, ['demo', '--headless', '--out', out, ...flags], { env });
  let err = '', sandbox = '', runId = '', socket = false;
  p.stderr!.on('data', (b) => {
    err += b;
    const x = err.match(/qa demo (\S+): sandbox (\S+)/);
    if (x && !sandbox) { runId = x[1]; sandbox = x[2]; }
  });
  const poll = setInterval(() => {
    if (!sandbox) return;
    try { socket ||= statSync(join(sandbox, 't')).isSocket(); } catch { /* not yet, or gone */ }
    during?.(sandbox, p);
  }, 50);
  const code = await new Promise<number | null>((ok) => p.on('exit', ok));
  clearInterval(poll);
  const read = (f: string) => readFileSync(join(out, f), 'utf8');
  return { code, err, sandbox, runId, socket, out, read };
}

/** Runs qa demo in a terminal (a window); once steps.json satisfies `when`, types `key` into the window (or, given a
 *  function, calls it with the sandbox). */
async function attached(m: TestMachine, flags: string[], when: (s: StepsFile) => boolean, key: string | ((sandbox: string) => void), env: Record<string, string> = demoEnv()) {
  const out = scratch('qa-demo-out-');
  const { p, type, close } = qaSpawnInTerminal(m, ['demo', '--out', out, ...flags], { env: { ...env, TERM: 'xterm-256color' } });
  let text = '', sandbox = '', sent = false;
  const seen = (b: Buffer) => {
    text += b;
    sandbox ||= text.match(/sandbox (\S+)/)?.[1] ?? '';
    if (/qa demo \S+: (pass|fail|leak|timeout|interrupted)/.test(text)) void close();   // qa is done: end the terminal's input
  };
  p.stdout!.on('data', seen);
  p.stderr!.on('data', seen);
  const poll = setInterval(() => {
    if (!sandbox || sent) return;
    try {
      if (!when(JSON.parse(readFileSync(join(sandbox, 'demo', 'steps.json'), 'utf8')))) return;
      sent = true;
      if (typeof key === 'string') void type(key); else key(sandbox);
    } catch { /* not yet */ }
  }, 50);
  const code = await new Promise<number | null>((ok) => p.on('exit', ok));
  clearInterval(poll);
  await close();
  return { code, sent, sandbox, out, text, tail: text.slice(-3000) };
}

/** A tmux server of the demo's own kind in a scratch folder, configured as the demo configures it; killed after the test. */
async function tmuxServer() {
  const dir = scratch('qa-demo-tmux-');
  const server = startServer(dir, { PATH: process.env.PATH ?? '' });
  servers.push({ kill: () => { spawnSync('tmux', ['-S', 't', '-f', '/dev/null', 'kill-server'], { cwd: dir }); server.kill('SIGKILL'); } });
  const t = tmuxAt(dir);
  await waitForServer(t);
  configure(t, { control: join(dir, 'control') });
  return { t, dir };
}
/** A pane's border format, expanded (before tmux reads #[…] styles and "##" while drawing it). */
const border = (t: Tmux, pane: string) => t('display-message', '-p', '-t', pane, '#{T:pane-border-format}').replace(/\n$/, '');
const DRAWN_COLS = 200;
/** Whether a captured screen's top row (every top pane's border, with its title) is drawn whole: all 200 columns, and no
 *  run of 3 blank cells (a border's title is padded by one space; tmux fills the title in after the border itself, so a
 *  row caught in between is blank where the titles go). Says nothing about what the titles are: the tests check that. */
function wholeFrame(screen: string): boolean {
  const top = screen.split('\n')[0];
  return [...top].length === DRAWN_COLS && !top.includes('   ');
}
/** What a client of the demo's server really draws: a second tmux server (socket `o`) runs a client in a 200x50 pane,
 *  and its screen is read back as plain text, rows joined by newlines, once it's finished: its top row is whole and two
 *  captures 100 ms apart are the same (a client draws a frame in pieces; on a busy machine the first capture that isn't
 *  blank can hold a border row without its titles). Killed after the test. */
async function drawn(dir: string): Promise<string> {
  const o = (...args: string[]) => spawnSync('tmux', ['-S', 'o', '-f', '/dev/null', '-u', ...args], { cwd: dir, encoding: 'utf8' });
  servers.push({ kill: () => { o('kill-server'); } });
  // inside the outer server $TMUX is set, and tmux refuses to nest a client unless it's unset
  o('new-session', '-d', '-s', 'outer', '-x', String(DRAWN_COLS), '-y', '50', 'unset TMUX; exec tmux -S t -f /dev/null -u -N attach-session -t demo');
  let last = '';
  for (const started = Date.now(); Date.now() - started < 10_000;) {
    await new Promise((r) => setTimeout(r, 100));
    const screen = o('capture-pane', '-p', '-t', 'outer').stdout;
    if (screen === last && wholeFrame(screen)) return screen;
    last = screen;
  }
  // the row's length only: the screen itself isn't printed (it could hold the host name)
  const top = last.split('\n')[0];
  throw new Error(`the client didn't finish drawing within 10 s: its top row is ${[...top].length} of ${DRAWN_COLS} columns${top.includes('   ') ? ', with blanks where titles go' : ''}${wholeFrame(last) ? ', and still changing' : ''}`);
}

describe('drawn(): a screen counts only once the client has drawn its top row whole', () => {
  // Rows captured from a client of the demo's layout (200 columns: ana, bob, Steps); tmux fills a border's title in
  // after the border itself, so a capture can land in between
  const fill = (row: string) => row + '─'.repeat(200 - [...row].length);
  it('a border row whose titles aren\'t drawn yet, a narrower window, or nothing at all isn\'t whole', () => {
    expect(wholeFrame('──' + ' '.repeat(74) + '┬──' + ' '.repeat(72) + '┬──\n│')).toBe(false);   // the flake's capture
    expect(wholeFrame(fill('──  ').slice(0, 120))).toBe(false);   // the window before it takes the client's size
    expect(wholeFrame('')).toBe(false);
  });
  it('a drawn row is whole whatever its titles say, so a wrong title still reaches the test\'s own check', () => {
    expect(wholeFrame(`${fill('── #(touch ran) #{host} ').slice(0, 76)}┬── odd ## #[fg=red]x #{pane_id}; ${'─'.repeat(41)}┬── Steps ${'─'.repeat(39)}\n│`)).toBe(true);
    expect(wholeFrame(fill('──  '))).toBe(true);   // a blank title
    expect(wholeFrame(fill(`── ${hostname()} `))).toBe(true);   // the host name drawn: whole, so the test sees it
  });
});

describe.skipIf(!!noTmux)(`qa demo with real tmux${noTmux ? ` (skipped: ${noTmux})` : ''}`, () => {
  it('a headless run plays the scene in four titled panes, saves each pane, and leaves nothing behind', async () => {
    const m = machine();
    const r = await demo(m, ['--pace', '0', '--size', '160x40'], demoEnv());
    expect(r.code, r.err).toBe(0);
    expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: pass${NOTHING_LEFT}`));
    expect(r.err).toContain('Done: 2 seen, 1 planned, 0 missed');
    // no catalog server installed: the core, and how to get the server
    expect(r.err).toContain("qa demo: the stand-ins call the core in their own process (../client isn't installed: npm ci --ignore-scripts there to use its MCP server)");
    // the run's ending is kept with the panes' text
    expect(r.read('status.txt')).toBe(`qa demo ${r.runId}: pass${NOTHING_LEFT}\n`);

    // the server's socket was inside the sandbox, by a relative path, and went with it
    expect(r.socket).toBe(true);
    expect(existsSync(r.sandbox)).toBe(false);
    const summary = JSON.parse(r.read('summary.json'));
    expect(summary.socket_path).toBe('t');

    // four panes: ana, bob and the steps side by side (38/38/24), the log full width along the bottom, 10 rows
    const boxes = layout(r.read('layout.txt'));
    expect(Object.keys(boxes).sort()).toEqual(['Catalog server log', 'Developer 1 · ana', 'Developer 2 · bob', 'Steps']);
    const { 'Developer 1 · ana': ana, 'Developer 2 · bob': bob, Steps: steps, 'Catalog server log': log } = boxes;
    for (const b of [bob, steps]) expect([b.top, b.height]).toEqual([ana.top, ana.height]);
    expect(ana.left).toBe(0);
    expect(bob.left).toBe(ana.left + ana.width + 1);
    expect(steps.left).toBe(bob.left + bob.width + 1);
    expect(steps.left + steps.width).toBe(160);
    expect(Math.abs(ana.width - bob.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(steps.width / 160 - 0.24)).toBeLessThan(0.02);
    expect(log).toEqual({ left: 0, top: 30, width: 160, height: 10 });
    expect(ana.top + ana.height).toBeLessThan(log.top);

    // each pane's text, the steps file and the log are saved
    expect(r.read('ana.txt')).toContain('published hello as ana');
    expect(r.read('ana.txt')).toContain('› publish my skill, hello');
    expect(r.read('bob.txt')).toContain('search done');
    expect(r.read('log.txt')).toMatch(/\d\d:\d\d:\d\d {2}ana {3}publish/);
    // for now the stand-ins write the log, not the catalog's server: its first line says so
    expect(r.read('log.txt').trimStart().split('\n')[0]).toBe(LOG_NOTE);
    expect(r.read('activity.log')).not.toContain(LOG_NOTE);
    // the test's stand-in keeps the log's rules too: a search logs its match count, never the query
    expect(r.read('activity.log')).toMatch(/^\d\d:\d\d:\d\d {2}bob {3}search +done +1 of 1 match$/m);
    expect(r.read('activity.log')).toMatch(/ana {3}publish/);
    expect(r.read('steps.txt')).toContain('Done: 2 seen, 1 planned, 0 missed.');
    // every pane's program has the sandbox's own home, never the real one
    for (const pane of ['ana.txt', 'bob.txt', 'steps.txt']) expect(r.read(pane), pane).toContain(`HOME=${join(r.sandbox, 'home')}`);
    // and a PATH of the system's folders only: no program on this machine is found by name (tmux and node go by path)
    for (const pane of ['ana.txt', 'bob.txt']) expect(r.read(pane), pane).toContain('PATH=/usr/bin:/bin');
    const final: StepsFile = JSON.parse(r.read('steps.json'));
    expect(final.steps.map((s) => [s.id, s.state])).toEqual([[1, 'planned'], [2, 'seen'], [3, 'seen']]);
    expect(summary.steps.map((s: { state: string }) => s.state)).toEqual(['planned', 'seen', 'seen']);

    // no tmux server, pane or other process of the run is left
    expect(summary.server_pid).toBeGreaterThan(0);
    for (const pid of [summary.server_pid, ...summary.pane_pids]) expect(alive(pid), `process ${pid}`).toBe(false);
    expect(runProcesses(r.runId)).toEqual([]);
  }, RUN_MS);

  it('a step whose expected text never shows is missed: exit 1, with what was missing', async () => {
    const m = machine();
    const r = await demo(m, ['--pace', '0'], demoEnv('scenes-missed.yaml'));
    expect(r.code, r.err).toBe(1);
    expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: fail${NOTHING_LEFT}`));
    const final: StepsFile = JSON.parse(r.read('steps.json'));
    expect(final.steps[0]).toMatchObject({ state: 'missed', missing: ['ana: a line the product never prints'] });
    expect(r.read('steps.txt')).toContain('Done: 0 seen, 0 planned, 1 missed.');
    expect(existsSync(r.sandbox)).toBe(false);
  }, RUN_MS);

  it('Ctrl-C mid-run tears everything down and exits 130', async () => {
    const m = machine();
    let signalled = false;
    const r = await demo(m, ['--pace', '30'], demoEnv(), (sandbox, p) => {
      if (signalled) return;
      try {
        const s: StepsFile = JSON.parse(readFileSync(join(sandbox, 'demo', 'steps.json'), 'utf8'));
        if (s.steps[0].state === 'planned') { signalled = true; p.kill('SIGINT'); }   // step 1 done, waiting the pace
      } catch { /* not yet */ }
    });
    expect(signalled).toBe(true);
    expect(r.code, r.err).toBe(130);
    expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: interrupted${NOTHING_LEFT}`));
    expect(existsSync(r.sandbox)).toBe(false);
    expect(runProcesses(r.runId)).toEqual([]);
  }, RUN_MS);

  for (const signal of ['SIGTERM', 'SIGHUP'] as const) {
    it(`${signal} to qa mid-run tears everything down and exits 130`, async () => {
      const m = machine();
      let signalled = false, pids: number[] = [];
      const r = await demo(m, ['--pace', '30'], demoEnv(), (sandbox, p) => {
        if (signalled) return;
        try {
          const s: StepsFile = JSON.parse(readFileSync(join(sandbox, 'demo', 'steps.json'), 'utf8'));
          if (s.steps[0].state !== 'planned') return;   // step 1 done, waiting the pace
          // the server and the panes' programs, to check each is gone after
          const t = spawnSync('tmux', ['-S', 't', '-N', 'list-panes', '-a', '-F', '#{pid} #{pane_pid}'], { cwd: sandbox, encoding: 'utf8' }).stdout;
          pids = [...new Set(t.split(/\s+/).filter(Boolean).map(Number))];
          signalled = true;
          p.kill(signal);
        } catch { /* not yet */ }
      });
      expect(signalled).toBe(true);
      expect(pids.length).toBeGreaterThanOrEqual(5);   // the server and four panes
      expect(r.code, r.err).toBe(130);
      expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: interrupted${NOTHING_LEFT}`));
      expect(existsSync(r.sandbox)).toBe(false);
      for (const pid of pids) expect(alive(pid), `process ${pid}`).toBe(false);
      expect(runProcesses(r.runId)).toEqual([]);
    }, RUN_MS);
  }

  it('an attached run shows the window in a terminal; Ctrl-C there closes it and leaves nothing behind', async () => {
    const m = machine();
    const out = scratch('qa-demo-out-');
    const { p, type, close } = qaSpawnInTerminal(m, ['demo', '--pace', '0', '--out', out], { env: { ...demoEnv(), TERM: 'xterm-256color' } });
    let text = '', sandbox = '', sent = false;
    const seen = (b: Buffer) => {
      text += b;
      sandbox ||= text.match(/sandbox (\S+)/)?.[1] ?? '';
      if (/qa demo \S+: (pass|fail|leak|timeout|interrupted)/.test(text)) void close();   // qa is done: end the terminal's input
    };
    p.stdout!.on('data', seen);
    p.stderr!.on('data', seen);
    const poll = setInterval(() => {
      if (!sandbox || sent) return;
      try {
        const s: StepsFile = JSON.parse(readFileSync(join(sandbox, 'demo', 'steps.json'), 'utf8'));
        if (s.message.startsWith('Done:')) { sent = true; void type('\x03'); }   // Ctrl-C, typed in the window
      } catch { /* not yet */ }
    }, 50);
    const code = await new Promise<number | null>((ok) => p.on('exit', ok));
    clearInterval(poll);
    await close();
    const tail = text.slice(-3000);
    expect(sent, tail).toBe(true);
    expect(tail).toMatch(new RegExp(`: pass${NOTHING_LEFT}`));
    expect(code, tail).toBe(0);
    expect(existsSync(sandbox)).toBe(false);
    const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ quit: true, counts: { seen: 2, planned: 1, missed: 0 } });
    expect(runProcesses(summary.run_id)).toEqual([]);
  }, RUN_MS);

  it('q mid-run in the window stops it: exit 130, stopped after step 1 with 2 not played, never a pass; nothing left behind', async () => {
    const m = machine();
    const r = await attached(m, ['--pace', '30'], (s) => s.steps[0].state === 'planned', 'q');   // step 1 done, waiting the pace
    expect(r.sent, r.tail).toBe(true);
    expect(r.code, r.tail).toBe(130);
    expect(r.tail).toContain('qa demo: stopped after step 1; 2 not played');
    expect(r.tail).toMatch(new RegExp(`: interrupted${NOTHING_LEFT}`));
    expect(r.tail).not.toMatch(/: pass|Done:/);
    expect(readFileSync(join(r.out, 'status.txt'), 'utf8')).toMatch(new RegExp(`^qa demo \\S+: interrupted${NOTHING_LEFT}\\n$`));
    expect(existsSync(r.sandbox)).toBe(false);
    const summary = JSON.parse(readFileSync(join(r.out, 'summary.json'), 'utf8'));
    expect(summary).toMatchObject({ quit: true, stopped: { after: 1, not_played: 2 }, counts: { seen: 0, planned: 1, missed: 0 } });
    expect(readFileSync(join(r.out, 'steps.txt'), 'utf8')).toContain('Stopped after step 1; 2 not played. Everything is removed.');
    expect(runProcesses(summary.run_id)).toEqual([]);
  }, RUN_MS);

  it('the window\'s tmux client killed mid-run: the run is stopped (nobody could press q any more), 130, nothing left behind', async () => {
    const m = machine();
    let killed = 0;
    const r = await attached(m, ['--pace', '30'], (s) => s.steps[0].state === 'planned', (sandbox) => {
      // No client attached (or gone): no pid, and nothing is signalled (a 0 would reach this test's own process group).
      killed = firstPid(spawnSync('tmux', ['-S', 't', '-N', 'list-clients', '-F', '#{client_pid}'], { cwd: sandbox, encoding: 'utf8' }).stdout ?? '') ?? 0;
      if (killed > 0) process.kill(killed, 'SIGKILL');
    });
    expect(killed, r.tail).toBeGreaterThan(0);
    expect(r.code, r.tail).toBe(130);
    expect(r.tail).toMatch(new RegExp(`: interrupted${NOTHING_LEFT}`));
    expect(existsSync(r.sandbox)).toBe(false);
    expect(runProcesses(basename(r.sandbox))).toEqual([]);
  }, RUN_MS);

  it('the director failing after its server started: exit 1, error.txt says why, nothing left behind', async () => {
    const m = machine();
    const r = await demo(m, ['--pace', '0', '--size', '100000x100'], demoEnv());   // a window tmux refuses to make
    expect(r.code, r.err).toBe(1);
    expect(r.read('error.txt')).toMatch(/^tmux new-session: /);   // a tmux command to the server it had started
    expect(r.err).toContain('qa demo: the director stopped: tmux new-session: ');
    expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: fail${NOTHING_LEFT}`));
    expect(existsSync(r.sandbox)).toBe(false);
    expect(runProcesses(r.runId)).toEqual([]);
  }, RUN_MS);

  it.skipIf(!ownServer)(`the real scene file plays end to end on this repository's catalog server (the default): 7 seen, 1 planned, 0 missed, nothing left behind${ownServer ? '' : ` (skipped: ${CLIENT} isn't installed)`}`, async () => {
    const m = machine();
    const r = await demo(m, ['--pace', '0'], {});
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain("qa demo: the stand-ins call this repository's MCP server (../client)");
    expect(r.err).toContain('qa demo: Done: 7 seen, 1 planned, 0 missed');
    expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: pass${NOTHING_LEFT}`));
    const summary = JSON.parse(r.read('summary.json'));
    expect(summary.steps.map((x: { state: string }) => x.state)).toEqual(['planned', 'seen', 'seen', 'seen', 'seen', 'seen', 'seen', 'seen']);
    // the developers' panes say, on their borders, that their assistants are scripted (it never scrolls away)
    expect(Object.keys(layout(r.read('layout.txt'))).sort()).toEqual(['Catalog server log', 'Developer 1 · ana (scripted)', 'Developer 2 · bob (scripted)', 'Steps']);
    expect(joined(r.read('bob.txt'))).toContain('Can run something new on this machine: yes');
    expect(r.read('bob.txt')).toContain('Take it? (y/N) y');   // bob's own answer, in his own pane
    expect(joined(r.read('ana.txt'))).toContain('(ana says yes to publishing)');
    // the servers write the log (a publish is its preview and its confirm), with no note from the stand-ins
    expect(r.read('log.txt')).not.toContain(LOG_NOTE);
    expect(r.read('activity.log')).toMatch(/ana {3}publish_skill_to_catalog +preview only +release-note-draft v1\n.*ana {3}publish_skill_to_catalog +published +release-note-draft v1\n/);
    expect(existsSync(r.sandbox)).toBe(false);
    expect(runProcesses(r.runId)).toEqual([]);
  }, RUN_MS);

  it('the real scene file with --core (the core in each stand-in): 6 seen, 2 planned, 0 missed; the log\'s first line says the stand-ins write it', async () => {
    const m = machine();
    const r = await demo(m, ['--pace', '0', '--core'], {});
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('qa demo: the stand-ins call the core in their own process');
    expect(r.err).toContain('qa demo: Done: 6 seen, 2 planned, 0 missed');
    expect(r.err).toMatch(new RegExp(`qa demo ${r.runId}: pass${NOTHING_LEFT}`));
    expect(r.read('log.txt').trimStart().split('\n')[0]).toBe(LOG_NOTE);
    expect(r.read('activity.log')).toMatch(/ana {3}publish_skill_to_catalog +published +release-note-draft v1\n/);
    expect(existsSync(r.sandbox)).toBe(false);
    expect(runProcesses(r.runId)).toEqual([]);
  }, RUN_MS);

  it('the real scene file at the narrowest size (80x24): the product\'s lines wrap in the panes, and every step still counts', async () => {
    const m = machine();
    const r = await demo(m, ['--pace', '0', '--size', '80x24'], {});
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain(`qa demo: Done: ${ownServer ? '7 seen, 1 planned' : '6 seen, 2 planned'}, 0 missed`);
    const bob = r.read('bob.txt');
    // wrapped: no one line holds it, the lines under the gutter do
    expect(bob.split('\n').some((l) => l.includes('Can run something new on this machine: yes'))).toBe(false);
    expect(joined(bob)).toContain('Can run something new on this machine: yes');
    expect(existsSync(r.sandbox)).toBe(false);
  }, RUN_MS);

  it('refuses a step --only doesn\'t know, a malformed --pace or --size, and --core with --server, before anything starts', () => {
    const m = machine();
    for (const [flags, line] of [
      [['--only', '9'], 'no step 9'], [['--pace', 'soon'], '--pace'], [['--close-after', 'soon'], '--close-after soon: a number of seconds'], [['--size', 'big'], '--size'],
      [['--core', '--server', process.execPath], '--core and --server: choose one'],
    ] as const) {
      const r = qaSync(m, ['demo', '--headless', ...flags], demoEnv());
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain(line);
    }
    expect(existsSync(sandboxBase(m.tmp))).toBe(false);
  });

  it('refuses an --out folder that already holds something (it writes only new files), before anything starts', () => {
    const m = machine();
    const out = scratch('qa-demo-out-');
    writeFileSync(join(out, 'ana.txt'), 'mine');
    const r = qaSync(m, ['demo', '--headless', '--out', out], demoEnv());
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(`qa demo: --out ${out}: not empty; choose a new folder, or leave --out off`);
    expect(readFileSync(join(out, 'ana.txt'), 'utf8')).toBe('mine');
    expect(existsSync(sandboxBase(m.tmp))).toBe(false);
  });

  it('nothing passes between the window and the terminal: no environment from the client, no clipboard, passthrough or title', async () => {
    const dir = scratch('qa-demo-tmux-');
    const server = startServer(dir, { PATH: process.env.PATH ?? '' });
    servers.push({ kill: () => { spawnSync('tmux', ['-S', 't', '-f', '/dev/null', 'kill-server'], { cwd: dir }); server.kill('SIGKILL'); } });
    const t = tmuxAt(dir);
    await waitForServer(t);
    expect(t('show-options', '-gv', 'update-environment').trim()).not.toBe('');   // tmux's default copies DISPLAY, SSH_AUTH_SOCK… from each client
    configure(t, { control: join(dir, 'control') });
    expect(t('show-options', '-gv', 'update-environment').trim()).toBe('');
    expect(t('show-options', '-sv', 'set-clipboard').trim()).toBe('off');
    expect(t('show-options', '-gv', 'set-titles').trim()).toBe('off');   // its default string holds #T: the host name
    // newer tmux only (3.3, 3.4): on an older one these options don't exist, and configure goes on without them
    for (const o of ['allow-passthrough', 'allow-set-title']) {
      let v: string | undefined;
      try { v = t('show-options', '-gv', o).trim(); } catch { /* an older tmux */ }
      if (v !== undefined) expect(v, o).toBe('off');
    }
  }, 60_000);

  it('without --fake-machine, DEMO_CORE, DEMO_ASSISTANT and DEMO_STEPS_VIEW mean nothing: the panes run the demo\'s own programs', () => {
    const env = { DEMO_ASSISTANT: '/x/assistant.mjs', DEMO_STEPS_VIEW: '/x/view.mjs', DEMO_CORE: '/x/core' };
    expect(demoPaths({ ...env, DEMO_CLIENT: '/x/client' }, true)).toEqual({ scenes: DEFAULTS.scenes, assistant: '/x/assistant.mjs', stepsView: '/x/view.mjs', core: '/x/core', client: '/x/client' });
    expect(demoPaths({ ...env, DEMO_CLIENT: '/x/client' }, false)).toEqual({ scenes: DEFAULTS.scenes, assistant: DEFAULTS.assistant, stepsView: DEFAULTS.stepsView, core: DEFAULTS.core, client: DEFAULTS.client });
    // on the command line: a core without its dependencies is refused only when it's the one used
    const saved = process.env.DEMO_CORE;
    onTestFinished(() => { if (saved === undefined) delete process.env.DEMO_CORE; else process.env.DEMO_CORE = saved; });
    process.env.DEMO_CORE = scratch('qa-core-');
    const r = qaBareSync(['demo', '--headless']);
    expect(r.stderr).not.toContain('run npm ci --ignore-scripts in ../core first');
    expect(r.stderr).toContain('the real machine is never used by a test process');   // past the pre-flight, refused at the machine
    expect(r.status).toBe(3);
  });

  it('without --fake-machine, DEMO_SCENES means nothing either: a real run always plays demo/scenes.yaml', () => {
    expect(demoPaths({ DEMO_SCENES: '/x/scenes.yaml' }, true).scenes).toBe('/x/scenes.yaml');
    expect(demoPaths({ DEMO_SCENES: '/x/scenes.yaml' }, false).scenes).toBe(DEFAULTS.scenes);
    // on the command line: a scene file that isn't there would be refused (exit 1) if it were read; it isn't
    const saved = process.env.DEMO_SCENES;
    onTestFinished(() => { if (saved === undefined) delete process.env.DEMO_SCENES; else process.env.DEMO_SCENES = saved; });
    const missing = join(scratch('qa-scenes-'), 'no-such-scenes.yaml');
    process.env.DEMO_SCENES = missing;
    const r = qaBareSync(['demo', '--headless']);
    expect(r.stderr).not.toContain(missing);
    expect(r.stderr).toContain('the real machine is never used by a test process');   // past the scene file, refused at the machine
    expect(r.status).toBe(3);
  });

  it('the usage lists every setting that counts only with --fake-machine', () => {
    const r = qaSync(null, ['--help']);
    expect(r.stdout.replace(/\s+/g, ' ')).toContain('with --fake-machine only: DEMO_SCENES, DEMO_ASSISTANT, DEMO_STEPS_VIEW, DEMO_CORE, DEMO_CLIENT');
  });

  it('a pane title is drawn as written: a tmux format (#(command) runs a command), a style (#[…]) or "##" in it is never read', async () => {
    const { t, dir } = await tmuxServer();
    // #(…) runs in the server's folder (dir): a short relative marker keeps the title inside its border
    const titles = { ana: '#(touch ran) #{host}', bob: 'odd ## #[fg=red]x #{pane_id};' };
    buildLayout(t, { developers: [{ id: 'ana', title: titles.ana }, { id: 'bob', title: titles.bob }], size: { cols: 200, rows: 50 }, cwd: dir });
    const top = (await drawn(dir)).split('\n')[0];
    await new Promise((r) => setTimeout(r, 1000));   // a #() job runs in the background: give it time to
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    for (const who of ['ana', 'bob'] as const) expect(top, who).toContain(` ${titles[who]} `);
  }, 60_000);

  it('a pane without a title has a blank border: tmux\'s own pane title (the host name) is never drawn', async () => {
    const { t, dir } = await tmuxServer();
    const pane = t('new-session', '-d', '-s', 'demo', '-x', '120', '-y', '30', '-c', dir, '-P', '-F', '#{pane_id}', '--', 'true').trim();
    expect(t('display-message', '-p', '-t', pane, '#{pane_title}').trim()).toBe(hostname());   // tmux's default
    expect(border(t, pane).trim()).toBe('');
    expect(await drawn(dir)).not.toContain(hostname());
  }, 60_000);

  it('every glyph the steps pane draws, in every state, is one column wide to tmux (it lays the panes out by width)', async () => {
    const { t, dir } = await tmuxServer();
    const pane = t('new-session', '-d', '-s', 'demo', '-x', '48', '-y', '10', '-c', dir, '-P', '-F', '#{pane_id}', '--', 'true').trim();
    const steps: StepsState = {
      title: 'what to look for', mode: 'step', paused: false, message: '', steps: (['seen', 'now', 'planned', 'missed', 'pending'] as const)
        .map((state, i) => ({ id: i + 1, title: `a step ${state}`, see: 'a text', state, ...(state === 'missed' ? { missing: ['a text'] } : {}) })),
    };
    const text = [null, ...(['starting', 'playing', 'pausing', 'paused', 'waiting', 'done'] as const).map((state) => ({ ...steps, state }))].map((s) => renderSteps(s, { width: 48 })).join('\n');
    const glyphs = [...new Set(text.replace(/\x1b\[[0-9;]*m/g, ''))].filter((c) => c > '~');
    expect(glyphs).toEqual(expect.arrayContaining(['▶', '‖', '·', '✓', '◌', '✗']));
    for (const g of glyphs) {
      t('set-option', '-t', 'demo', '@glyph', g);
      expect(t('display-message', '-p', '-t', pane, '#{w:@glyph}').trim(), `${g} U+${g.codePointAt(0)!.toString(16)}`).toBe('1');
    }
  }, 60_000);

  it('the window opens only when the demo says it\'s ready: the layout alone (titles, placeholder panes) isn\'t enough', async () => {
    const { t, dir } = await tmuxServer();
    buildLayout(t, { developers: [{ id: 'ana', title: 'Developer 1 · ana' }, { id: 'bob', title: 'Developer 2 · bob' }], size: { cols: 200, rows: 50 }, cwd: dir });
    const env = { PATH: process.env.PATH ?? '' };
    expect(await waitForSession(dir, env, 300)).toBe(false);
    const started = Date.now();   // a run that has already ended stops the wait at once, not after its timeout
    expect(await waitForSession(dir, env, 10_000, () => false)).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    markReady(t);
    expect(await waitForSession(dir, env, 300)).toBe(true);
  }, 60_000);

  it('an attached window never draws the host name or a "Pane is dead" placeholder, from its first frame', async () => {
    const m = machine();
    const r = await attached(m, ['--pace', '0'], (s) => s.message.startsWith('Done:'), '\x03');
    expect(r.sent, r.tail).toBe(true);
    expect(r.code, r.tail).toBe(0);
    expect(r.text.includes(hostname()), 'the host name was drawn').toBe(false);   // a boolean: no screen dump on failure
    expect(r.text.includes('Pane is dead'), 'a placeholder pane was drawn').toBe(false);
  }, RUN_MS);

  it('--server: a first word that isn\'t an absolute path, or isn\'t there, is refused before anything starts; its command goes to each developer pane as DEMO_MCP', async () => {
    const m = machine();
    for (const [server, line] of [['node cli.ts mcp', 'absolute path'], [`${join(m.dir, 'no-such-node')} cli.ts mcp`, "isn't there"]] as const) {
      const bad = qaSync(m, ['demo', '--headless', '--server', server], demoEnv());
      expect(bad.status, bad.stderr).toBe(1);
      expect(bad.stderr).toMatch(new RegExp(`qa demo: --server: .*${line}`));
    }
    expect(existsSync(sandboxBase(m.tmp))).toBe(false);
    const command = `${process.execPath} ${fixture('fake-catalog-server.mjs')}`;
    const r = await demo(m, ['--pace', '0', '--server', command], demoEnv());
    expect(r.code, r.err).toBe(0);
    for (const pane of ['ana.txt', 'bob.txt']) expect(r.read(pane).replace(/\n/g, ''), pane).toContain(`DEMO_MCP=${command}`);
    expect(existsSync(r.sandbox)).toBe(false);
  }, RUN_MS);

  it('the layout has its final sizes before any program starts: a window attaching changes no pane\'s width', async () => {
    const { t, dir } = await tmuxServer();
    buildLayout(t, { developers: [{ id: 'ana', title: 'Developer 1 · ana' }, { id: 'bob', title: 'Developer 2 · bob' }], size: { cols: 200, rows: 50 }, cwd: dir });
    const sizes = () => t('list-panes', '-t', 'demo', '-F', '#{@title} #{pane_width}x#{pane_height}').trim();
    const before = sizes();   // what each pane's program reads when it starts
    await drawn(dir);         // a client attaches: the layout's hooks run
    await new Promise((r) => setTimeout(r, 200));
    expect(sizes()).toBe(before);
  }, 60_000);

  it('the layout keeps the log at 10 rows and the 38/38/24 split when the window is resized', async () => {
    const dir = scratch('qa-demo-tmux-');
    const server = startServer(dir, { PATH: process.env.PATH ?? '' });
    servers.push({ kill: () => { spawnSync('tmux', ['-S', 't', '-f', '/dev/null', 'kill-server'], { cwd: dir }); server.kill('SIGKILL'); } });
    const t = tmuxAt(dir);
    await waitForServer(t);
    configure(t, { control: join(dir, 'control') });
    const panes = buildLayout(t, { developers: [{ id: 'ana', title: 'Developer 1 · ana' }, { id: 'bob', title: 'Developer 2 · bob' }], size: { cols: 200, rows: 50 }, cwd: dir });
    expect(Object.keys(panes).sort()).toEqual(['ana', 'bob', 'log', 'steps']);
    expect(t('display', '-p', '#{pane_id}').trim()).toBe(panes.steps);   // the steps pane has the keys
    t('resize-window', '-t', 'demo', '-x', '120', '-y', '30');
    const box = (id: string) => { const [w, h] = t('display', '-p', '-t', id, '#{pane_width} #{pane_height}').trim().split(' ').map(Number); return { w, h }; };
    for (let i = 0; i < 50 && box(panes.log).h !== 10; i++) await new Promise((r) => setTimeout(r, 20));
    expect(box(panes.log)).toEqual({ w: 120, h: 10 });
    expect(Math.abs(box(panes.steps).w / 120 - 0.24)).toBeLessThan(0.02);
    expect(Math.abs(box(panes.ana).w - box(panes.bob).w)).toBeLessThanOrEqual(1);
    // no key reaches tmux itself (no detaching, no splitting); Ctrl-C always ends the demo
    const keys = t('list-keys').split('\n').filter((l) => l.trim() && !/-T copy-mode/.test(l));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/-T root +C-c +run-shell -b .*quit.*control/);
  }, 60_000);
});

describe('qa demo pre-flight: exit 3, one plain line each, nothing started', () => {
  const refused = (m: TestMachine, flags: string[], env: Record<string, string>, line: string) => {
    const r = qaSync(m, ['demo', ...flags], { ...demoEnv(), ...env });
    expect(r.status, r.stderr).toBe(3);
    expect(r.stderr.split('\n')).toContain(`qa demo: ${line}`);
    expect(existsSync(sandboxBase(m.tmp))).toBe(false);
  };

  it('tmux missing', () => { const m = machine(); refused(m, ['--headless'], { PATH: scratch('qa-empty-bin-') }, 'needs tmux 3.2 or later'); });

  it('tmux older than 3.2', () => {
    const m = machine();
    const bin = scratch('qa-old-tmux-');
    writeFileSync(join(bin, 'tmux'), '#!/bin/sh\necho "tmux 3.1c"\n');
    chmodSync(join(bin, 'tmux'), 0o755);
    refused(m, ['--headless'], { PATH: `${bin}:${process.env.PATH}` }, 'needs tmux 3.2 or later');
  });

  it("the core's dependencies missing", () => { const m = machine(); refused(m, ['--headless'], { DEMO_CORE: scratch('qa-core-') }, 'run npm ci --ignore-scripts in ../core first'); });

  it('no terminal without --headless', () => { const m = machine(); refused(m, [], {}, 'needs a terminal: run it in one, or add --headless'); });

  it('--live', () => { const m = machine(); refused(m, ['--headless', '--live'], {}, 'not yet: real assistants in the panes come later'); });

  it('the pre-flight as a function: each problem its own line, none when all is well', () => {
    const core = scratch('qa-core-');
    const ok = { tmux: 'tmux 3.7c', coreDir: fileURLToPath(new URL('../../core', import.meta.url)), tty: true, headless: false, live: false };
    expect(preflight(ok)).toEqual([]);
    expect(preflight({ ...ok, tty: false, headless: true })).toEqual([]);
    expect(preflight({ ...ok, tmux: null, coreDir: core, tty: false, headless: false, live: true })).toEqual([
      'needs tmux 3.2 or later', 'run npm ci --ignore-scripts in ../core first', 'needs a terminal: run it in one, or add --headless', 'not yet: real assistants in the panes come later',
    ]);
    for (const v of ['tmux 3.2', 'tmux 3.2a', 'tmux 3.7c', 'tmux 10.0', 'tmux next-3.6', 'tmux master']) expect(versionOk(v), v).toBe(true);
    for (const v of ['tmux 3.1c', 'tmux 2.9', 'tmux 1.8', 'tmux', '', null]) expect(versionOk(v), String(v)).toBe(false);
  });

  it('Node older than 24.15 (package.json engines) is refused with one plain line', () => {
    const ok = { tmux: 'tmux 3.7c', coreDir: fileURLToPath(new URL('../../core', import.meta.url)), tty: true, headless: false, live: false };
    expect(preflight({ ...ok, node: '24.14.1' })).toEqual(['needs Node 24.15 or later (this is Node 24.14.1)']);
    expect(preflight({ ...ok, node: '24.15.0' })).toEqual([]);
    for (const v of ['24.15.0', '24.16.2', '25.0.0', '100.1.0']) expect(nodeOk(v), v).toBe(true);
    for (const v of ['24.14.9', '24.2.0', '23.99.0', '22.18.0', '', 'x']) expect(nodeOk(v), v).toBe(false);
  });
});

describe('how a demo run ends', () => {
  const run = (over: Partial<RunResult>): RunResult => ({ status: 'pass', exitCode: 0, differences: [], sandbox: '/s', runId: 'r', stopped: [], janitor: { removed: [], skipped: [] }, teardown: { removed: [], skipped: [] }, ...over });

  it('a director that wrote no summary is a failure (exit 1), never a pass, and says so', () => {
    for (const r of [run({}), run({ status: 'fail', exitCode: 137 }), run({ status: 'fail', exitCode: 130 })]) {
      expect(demoEnding(r, { summary: false, stopped: false })).toEqual({ ended: { ...r, status: 'fail', exitCode: 1 }, note: 'the director wrote no summary' });
    }
    // it said why itself (error.txt): the same failure, without the note
    expect(demoEnding(run({ status: 'fail', exitCode: 1 }), { summary: false, stopped: false, error: true })).toEqual({ ended: run({ status: 'fail', exitCode: 1 }) });
    // a timeout, a stop and something left behind keep their own endings
    for (const status of ['timeout', 'interrupted', 'leak'] as const) expect(demoEnding(run({ status, exitCode: null }), { summary: false, stopped: false }).ended.status).toBe(status);
  });

  it('with a summary: a pass is a pass, and a stop (q or Ctrl-C before the last step) is interrupted, not a failure', () => {
    expect(demoEnding(run({}), { summary: true, stopped: false })).toEqual({ ended: run({}) });
    expect(demoEnding(run({ status: 'fail', exitCode: 130 }), { summary: true, stopped: true }).ended.status).toBe('interrupted');
    expect(demoEnding(run({ status: 'fail', exitCode: 1 }), { summary: true, stopped: false }).ended).toMatchObject({ status: 'fail', exitCode: 1 });
  });

  it('an attached run has no time limit (q and Ctrl-C are there); a headless one keeps qa run\'s', () => {
    expect(demoTimeoutMs(false)).toBe(Infinity);
    expect(demoTimeoutMs(true)).toBeUndefined();
  });
});

describe('the catalog the stand-ins call by default', () => {
  it('is this repository\'s own server once its dependencies are installed, as a JSON array of its words (a path with a space stays one word)', () => {
    const client = join(scratch('qa-client-'), 'my client');
    mkdirSync(client);
    expect(repoServer(client)).toBeUndefined();   // not installed: the core
    mkdirSync(join(client, 'node_modules'));
    expect(serverCommand(repoServer(client)!)).toEqual([process.execPath, join(client, 'src', 'cli.ts'), 'mcp']);
    expect(serverCommand('["/a b/node", "/c d/cli.ts", "mcp"]')).toEqual(['/a b/node', '/c d/cli.ts', 'mcp']);
    for (const bad of ['["node", "cli.ts"]', '[1, 2]', '["/a", ""]', '[not json', '[]']) expect(() => serverCommand(bad), bad).toThrow();
  });
});

describe('send-keys text', () => {
  it('a chunk that ends with ";" is escaped (tmux would read it as the end of a command)', () => {
    expect(literal('a;b')).toBe('a;b');
    expect(literal('ends;')).toBe('ends\\;');
    expect(literal('odd\\;')).toBe('odd\\\\;');
  });

  it('several commands go in one call, each ended by a lone ";" (a title ending in ";" is escaped, not an end)', () => {
    expect(batch([['set-option', '-g', 'status', 'off'], ['unbind-key', '-a']])).toEqual(['set-option', '-g', 'status', 'off', ';', 'unbind-key', '-a']);
    expect(batch([['select-pane', '-T', literal('odd;')]])).toEqual(['select-pane', '-T', 'odd\\;']);
    expect(batch([])).toEqual([]);
  });
});

// The conductor on its own, with fake panes that answer the test scene: every wait is counted, and yields, never sleeps.
type Answer = { print: string; turn?: Partial<Turn> | null };
/** `answered`: the turn of an ask whose answer said `turn: null`, arriving now (an assistant still answering until then). */
type World = { io: ConductorIo; panes: Record<string, string>; writes: StepsFile[]; typed: { who: string; text: string; instant: boolean }[]; slept: number; queue: (word: string) => void; answered: (who: string, say: string) => void };
const ANSWERS: Record<string, string> = { 'set me up': '● setup: arrives with the installer', 'publish my skill, hello': 'published hello as ana', 'find a skill that says hello': 'search done' };
const MARK: Record<string, string> = { seen: '✓', now: '▶', planned: '◌', missed: '✗', pending: ' ' };
function world(o: { answer?: (who: string, say: string) => Answer; onWrite?: (s: StepsFile, w: World) => void; onSleep?: (w: World) => void } = {}): World {
  const turns: Turn[] = [];
  const control: string[] = [];
  const w: World = {
    panes: { ana: 'ana\n› ', bob: 'bob\n› ', steps: '', log: '' }, writes: [], typed: [], slept: 0,
    queue: (word) => { control.push(word); },
    answered: (who, say) => { turns.push({ who, say, step: 1, ok: true, at: '' }); },
    io: {
      async type(who, text, instant) {
        w.typed.push({ who, text, instant });
        const a = o.answer?.(who, text) ?? { print: ANSWERS[text] ?? '(this stand-in only knows the demo\'s steps)' };
        w.panes[who] += `${text}\n${a.print}\n› `;
        w.panes.log += `12:00:00  ${who}  ${text}\n`;
        if (a.turn !== null) turns.push({ who, say: text, step: 1, ok: true, at: '', ...a.turn });
      },
      capture: (pane) => w.panes[pane],
      turns: () => [...turns],
      control: () => control.splice(0),
      writeSteps(s) {
        w.writes.push(structuredClone(s));
        w.panes.steps = [s.title, ...s.steps.map((x) => `${MARK[x.state]} ${x.id}  ${x.title}`), s.message].join('\n');
        o.onWrite?.(s, w);
      },
      async sleep(ms) { w.slept += ms; o.onSleep?.(w); await new Promise((r) => setImmediate(r)); },
    },
  };
  return w;
}
const scenes = (): Scenes => loadScenes(fixture('scenes.yaml'));
const only2 = (): Scenes => { const s = scenes(); s.steps = [s.steps[1]]; return s; };
const states = (s: StepsFile) => s.steps.map((x) => x.state);

describe('the conductor', () => {
  it('marks each step now, then seen, planned or missed, and ends with the counts', async () => {
    const w = world();
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(r.counts).toEqual({ seen: 2, planned: 1, missed: 0 });
    expect(r.quit).toBe(false);
    expect(w.writes[0]).toMatchObject({ title: 'what to look for', mode: 'auto', paused: false, state: 'starting', keys: false });   // headless: no keys line
    expect(w.writes.map(states)).toContainEqual(['now', 'pending', 'pending']);
    expect(w.writes.map(states)).toContainEqual(['planned', 'now', 'pending']);
    expect(w.writes.map(states)).toContainEqual(['planned', 'seen', 'now']);
    const last = w.writes.at(-1)!;
    expect(states(last)).toEqual(['planned', 'seen', 'seen']);
    expect(last.steps.map((x) => x.missing)).toEqual([undefined, undefined, undefined]);
    expect(last.steps[1]).toMatchObject({ id: 2, title: 'ana publishes hello', see: '"published hello as ana"' });
    expect(last.message).toBe('Done: 2 seen, 1 planned, 0 missed.');   // headless: there is no q to press
    expect(last.state).toBe('done');
    expect(r.stopped).toBeNull();
    expect(w.typed.map((t) => [t.who, t.text])).toEqual([['ana', 'set me up'], ['bob', 'set me up'], ['ana', 'publish my skill, hello'], ['bob', 'find a skill that says hello']]);
    expect(w.typed.every((t) => t.instant)).toBe(true);   // pace 0 types at once
  });

  it('a missing text makes the step missed, named with its pane', async () => {
    const w = world({ answer: (who, say) => ({ print: say === 'publish my skill, hello' ? 'published hello as bob' : ANSWERS[say] }) });
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(r.counts).toEqual({ seen: 1, planned: 1, missed: 1 });
    expect(r.steps[1]).toMatchObject({ state: 'missed', missing: ['ana: published hello as ana'] });
    expect(w.writes.at(-1)!.message).toMatch(/^Done: 1 seen, 1 planned, 1 missed\./);
  });

  it('only text that appeared during the step counts', async () => {
    const w = world({ answer: () => ({ print: 'nothing new' }) });
    w.panes.ana += 'published hello as ana\n';   // already on the screen before the step
    const r = await conduct(only2(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(r.steps[0]).toMatchObject({ state: 'missed', missing: ['ana: published hello as ana'] });
  });

  it('an assistant that never answers, doesn\'t know the ask, or hits an error misses the step', async () => {
    let w = world({ answer: () => ({ print: 'published hello as ana', turn: null }) });
    let r = await conduct(only2(), w.io, { mode: 'auto', pace: 0, attached: false, turnTimeoutMs: 1000 });
    expect(r.steps[0]).toMatchObject({ state: 'missed', missing: ['ana didn\'t answer "publish my skill, hello" within 1 s'] });
    w = world({ answer: () => ({ print: 'published hello as ana', turn: { step: null } }) });
    r = await conduct(only2(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(r.steps[0]).toMatchObject({ state: 'missed', missing: ['ana\'s assistant didn\'t know "publish my skill, hello"'] });
    w = world({ answer: () => ({ print: 'published hello as ana', turn: { ok: false } }) });
    r = await conduct(only2(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(r.steps[0]).toMatchObject({ state: 'missed', missing: ['ana\'s assistant hit an unexpected error'] });
  });

  it('types in small chunks at a pace, and waits the pace after each step but the last', async () => {
    const w = world();
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(r.counts).toEqual({ seen: 2, planned: 1, missed: 0 });
    expect(w.typed.every((t) => !t.instant)).toBe(true);
    expect(w.slept).toBeGreaterThanOrEqual(6000);
    expect(w.slept).toBeLessThan(6500);
  });

  it('--only runs the steps before it at once, with no pause, and none after', async () => {
    const w = world();
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: false, only: ['2'] });
    expect(w.typed.map((t) => [t.text, t.instant])).toEqual([['set me up', true], ['set me up', true], ['publish my skill, hello', false]]);
    expect(w.slept).toBeLessThan(500);
    expect(r.steps.map((s) => s.state)).toEqual(['planned', 'seen', 'pending']);
    expect(r.counts).toEqual({ seen: 1, planned: 1, missed: 0 });
  });

  it('--step waits for Enter before each step', async () => {
    const w = world({ onWrite: (s, w) => { if (s.state === 'waiting') w.queue('next'); } });
    const r = await conduct(scenes(), w.io, { mode: 'step', pace: 3, attached: false });
    expect(w.writes.filter((s) => s.state === 'waiting').map(states)).toEqual([
      ['pending', 'pending', 'pending'], ['planned', 'pending', 'pending'], ['planned', 'seen', 'pending'],
    ]);
    expect(w.writes[0].mode).toBe('step');
    expect(r.counts).toEqual({ seen: 2, planned: 1, missed: 0 });
  });

  it('p holds the pace however long, until p again; Enter goes on at once', async () => {
    let phase = 0;
    let w = world({
      onWrite: (s, w) => { if (phase === 0 && s.steps[0].state === 'planned') { phase = 1; w.queue('pause'); } },
      onSleep: (w) => { if (phase === 1 && w.slept > 60_000) { phase = 2; w.queue('pause'); } },
    });
    let r = await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(w.writes.some((s) => s.paused && s.state === 'paused')).toBe(true);
    expect(w.writes.at(-1)!.paused).toBe(false);
    expect(w.slept).toBeGreaterThan(60_000);
    expect(r.counts).toEqual({ seen: 2, planned: 1, missed: 0 });

    w = world({ onWrite: (s, w) => { if (s.steps.some((x) => x.state === 'now')) return; if (s.state === 'playing') w.queue('next'); } });
    r = await conduct(scenes(), w.io, { mode: 'auto', pace: 30, attached: false });
    expect(w.slept).toBeLessThan(1000);   // Enter after each step: no 30 s waits
  });

  it('writes whether it is playing, paused or waiting for Enter: p shows paused within one tick, p again playing; done at the end', async () => {
    // auto: p after step 1, p again 5 s later
    let phase = 0, pressed = -1, again = -1;
    const at: { state: string; paused: boolean; slept: number }[] = [];
    let w = world({
      onWrite: (s, w) => { at.push({ state: s.state, paused: s.paused, slept: w.slept }); if (phase === 0 && s.steps[0].state === 'planned') { phase = 1; pressed = w.slept; w.queue('pause'); } },
      onSleep: (w) => { if (phase === 1 && w.slept >= pressed + 5000) { phase = 2; again = w.slept; w.queue('pause'); } },
    });
    await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(phase).toBe(2);
    const paused = at.findIndex((x) => x.state === 'paused');
    expect(paused).toBeGreaterThan(-1);
    expect(at[paused].paused).toBe(true);
    expect(at[paused].slept - pressed).toBeLessThanOrEqual(50);   // one tick: the pane redraws within a second
    const resumed = at.findIndex((x, i) => i > paused && x.state !== 'paused');
    expect(at[resumed]).toMatchObject({ state: 'playing', paused: false });
    expect(at[resumed].slept - again).toBeLessThanOrEqual(50);
    expect(at[0].state).toBe('starting');   // until every developer's prompt shows
    expect(at.slice(1, paused).every((x) => x.state === 'playing')).toBe(true);
    expect(at.at(-1)!.state).toBe('done');
    expect(w.writes.every((s) => !/^(Paused|Press Enter)/.test(s.message))).toBe(true);   // the state says it, not the message

    // --step: waiting before each step; p while waiting shows paused, p again waiting
    phase = 0;
    w = world({
      onWrite: (s, w) => {
        if (s.state !== 'waiting' && s.state !== 'paused') return;
        if (phase === 0) { phase = 1; w.queue('pause'); } else if (phase === 1) { phase = 2; w.queue('pause'); } else if (s.state === 'waiting') w.queue('next');
      },
    });
    await conduct(scenes(), w.io, { mode: 'step', pace: 3, attached: false });
    expect(w.writes.map((s) => s.state).filter((s, i, a) => s !== a[i - 1])).toEqual([
      'starting', 'waiting', 'paused', 'waiting', 'playing', 'waiting', 'playing', 'waiting', 'playing', 'done',
    ]);
  });

  // Step 1 of the test scene has two asks (ana's, then bob's). ana's assistant answers only when the test says so.
  const slowAna = (w: () => World) => (who: string, say: string): Answer =>
    ({ print: ANSWERS[say], turn: who === 'ana' && say === 'set me up' && w().typed.length === 1 ? null : undefined });
  const runs = (w: World) => w.writes.map((s) => s.state).filter((s, i, a) => s !== a[i - 1]);

  it('p while an assistant answers: pausing until the answer comes, then paused before the next ask, nothing typed; p again plays on', async () => {
    let phase = 0, heldAt = -1, typedWhileHeld = -1;
    const w: World = world({
      answer: slowAna(() => w),
      onSleep: (w) => {
        const now = w.writes.at(-1)!.state;
        if (phase === 0 && w.typed.length === 1) { phase = 1; w.queue('pause'); }   // ana's assistant is answering
        else if (phase === 1 && now === 'pausing') { phase = 2; w.answered('ana', 'set me up'); }
        else if (phase === 2 && now === 'paused') { phase = 3; heldAt = w.slept; }
        else if (phase === 3 && w.slept - heldAt >= 10_000) { phase = 4; typedWhileHeld = w.typed.length; w.queue('pause'); }
      },
    });
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(phase).toBe(4);
    expect(typedWhileHeld).toBe(1);   // 10 s paused: bob's ask not typed
    expect(runs(w).slice(0, 5)).toEqual(['starting', 'playing', 'pausing', 'paused', 'playing']);
    expect(w.writes.find((s) => s.state === 'pausing')!.paused).toBe(true);
    expect(w.typed.map((t) => t.who)).toEqual(['ana', 'bob', 'ana', 'bob']);
    expect(r.counts).toEqual({ seen: 2, planned: 1, missed: 0 });
  });

  // As the shipped step 8: step 1's first ask is answered with a y at the assistant's question (a `then`), then bob asks;
  // step 2 has two asks too. p is pressed as ana's first ask is typed, so the y is held.
  const thenScenes = (): Scenes => {
    const s = scenes();
    s.steps[0].asks[0].then = [{ type: 'y', after: 'Take it? (y/N)' }];
    s.steps[1].asks.push({ ...s.steps[2].asks[0] });
    return s;
  };
  const pauseAtQuestion = (w: () => World) => (who: string, say: string): Answer => {
    if (who === 'ana' && say === 'set me up') { w().queue('pause'); return { print: 'Take it? (y/N)', turn: null }; }
    return { print: say === 'y' ? 'Took it' : ANSWERS[say] };
  };
  const where = (w: World) => w.writes.map((s) => (s.state === 'paused' ? `paused ${s.pausedIn}` : s.state)).filter((s, i, a) => s !== a[i - 1]);

  it('a then answer is held while paused; Enter mid-step finishes the step (every ask and answer left), then it holds; Enter between steps plays one whole step', async () => {
    let phase = 0, heldAt = -1;
    const typedAt: string[][] = [];
    const w: World = world({
      answer: pauseAtQuestion(() => w),
      onSleep: (w) => {
        const s = w.writes.at(-1)!, held = () => w.slept - heldAt >= 10_000, typed = () => w.typed.map((t) => t.text);
        if (phase === 0 && s.state === 'paused') { phase = 1; heldAt = w.slept; }   // at ana's question
        else if (phase === 1 && held()) { phase = 2; typedAt.push(typed()); w.queue('next'); }
        else if (phase === 2 && s.state === 'paused' && s.pausedIn === 'between') { phase = 3; heldAt = w.slept; }
        else if (phase === 3 && held()) { phase = 4; typedAt.push(typed()); w.queue('next'); }
        else if (phase === 4 && s.state === 'paused' && w.typed.length === 5) { phase = 5; heldAt = w.slept; }
        else if (phase === 5 && held()) { phase = 6; typedAt.push(typed()); w.queue('pause'); }
      },
    });
    const r = await conduct(thenScenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(phase).toBe(6);
    expect(typedAt).toEqual([
      ['set me up'],                                           // 10 s at the question: the y held
      ['set me up', 'y', 'set me up'],                         // Enter: the rest of step 1, then 10 s held
      ['set me up', 'y', 'set me up', 'publish my skill, hello', 'find a skill that says hello'],   // Enter: all of step 2
    ]);
    expect(where(w)).toEqual(['starting', 'playing', 'pausing', 'paused step', 'pausing', 'paused between', 'pausing', 'paused between', 'playing', 'done']);
    expect(w.typed).toHaveLength(6);
    expect(r.counts).toEqual({ seen: 2, planned: 1, missed: 0 });
  });

  it('q while holding ends the run at once: mid-step (step 1 left pending) and between steps', async () => {
    let quitAt = -1;
    let w: World = world({ answer: pauseAtQuestion(() => w), onSleep: (w) => { if (quitAt < 0 && w.writes.at(-1)!.state === 'paused') { quitAt = w.slept; w.queue('quit'); } } });
    let r = await conduct(thenScenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(r.quit).toBe(true);
    expect(w.slept - quitAt).toBeLessThanOrEqual(50);
    expect(w.typed.map((t) => t.text)).toEqual(['set me up']);
    expect(r.stopped).toEqual({ after: null, not_played: 3 });

    quitAt = -1;
    let pressed = false;
    w = world({
      onWrite: (s, w) => { if (s.steps[0].state === 'planned' && !pressed) { pressed = true; w.queue('pause'); } },
      onSleep: (w) => { const s = w.writes.at(-1)!; if (quitAt < 0 && s.state === 'paused' && s.pausedIn === 'between') { quitAt = w.slept; w.queue('quit'); } },
    });
    r = await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: false });
    expect(w.slept - quitAt).toBeLessThanOrEqual(50);
    expect(r.stopped).toEqual({ after: 1, not_played: 2 });
  });

  it('p while starting holds at once: paused between steps (nothing is under way), never pausing; p again plays', async () => {
    let phase = 0, shownAt = -1, typedWhileHeld = -1;
    const w = world({
      onSleep: (w) => {
        if (phase === 0) { phase = 1; w.queue('pause'); }
        else if (phase === 1 && w.slept >= 500) { phase = 2; shownAt = w.slept; w.panes.ana = 'ana\n› '; }   // the prompts show
        else if (phase === 2 && w.slept - shownAt >= 10_000) { phase = 3; typedWhileHeld = w.typed.length; w.queue('pause'); }
      },
    });
    w.panes.ana = '';
    await conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(phase).toBe(3);
    expect(typedWhileHeld).toBe(0);
    expect(where(w)).toEqual(['starting', 'paused between', 'playing', 'done']);
    expect(w.typed).toHaveLength(4);
  });

  it('p forgets an Enter pressed before it: a stale Enter never lets an ask through under pausing', async () => {
    let phase = 0, heldAt = -1, typedWhileHeld = -1;
    const w: World = world({
      answer: slowAna(() => w),
      onSleep: (w) => {
        const now = w.writes.at(-1)!.state;
        if (phase === 0 && w.typed.length === 1) { phase = 1; w.queue('next'); }   // Enter while ana's assistant answers
        else if (phase === 1) { phase = 2; w.queue('pause'); }
        else if (phase === 2 && now === 'pausing') { phase = 3; w.answered('ana', 'set me up'); }
        else if (phase === 3 && now === 'paused') { phase = 4; heldAt = w.slept; }
        else if (phase === 4 && w.slept - heldAt >= 10_000) { phase = 5; typedWhileHeld = w.typed.length; w.queue('pause'); }
      },
    });
    await conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(phase).toBe(5);
    expect(typedWhileHeld).toBe(1);   // bob's ask waited for p
  });

  it('q ends early and leaves the rest pending: stopped after the last step played, and how many were not', async () => {
    const w = world({ onWrite: (s, w) => { if (s.steps[0].state === 'planned') w.queue('quit'); } });
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 3, attached: true });
    expect(r.quit).toBe(true);
    expect(r.steps.map((s) => s.state)).toEqual(['planned', 'pending', 'pending']);
    expect(w.typed).toHaveLength(2);
    expect(r.stopped).toEqual({ after: 1, not_played: 2 });
    expect(stoppedLine(r.stopped!)).toBe('stopped after step 1; 2 not played');
    expect(r.end).toBe('Stopped after step 1; 2 not played');
    expect(w.writes.at(-1)!.message).toBe('Stopped after step 1; 2 not played. Everything is removed.');
  });

  it('q before the first step: stopped before any step was played; q in --only counts only the steps it would play', async () => {
    let w = world({ onWrite: (s, w) => { if (s.state === 'waiting') w.queue('quit'); } });
    let r = await conduct(scenes(), w.io, { mode: 'step', pace: 0, attached: true });
    expect(r.steps.map((s) => s.state)).toEqual(['pending', 'pending', 'pending']);
    expect(r.stopped).toEqual({ after: null, not_played: 3 });
    expect(stoppedLine(r.stopped!)).toBe('stopped before the first step; 3 not played');
    w = world({ onWrite: (s, w) => { if (s.state === 'waiting') w.queue('quit'); } });
    r = await conduct(scenes(), w.io, { mode: 'step', pace: 0, attached: true, only: ['2'] });   // step 1 at once, then Enter for 2
    expect(r.stopped).toEqual({ after: 1, not_played: 1 });   // step 3 was never going to play
  });

  it('attached, it waits for q after the last step; headless, it ends there', async () => {
    let done = false;
    const w = world({ onWrite: (s) => { if (s.message.startsWith('Done:')) done = true; } });
    const run = conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: true });
    let settled = false;
    void run.then(() => { settled = true; });
    for (let i = 0; i < 500 && !done; i++) await new Promise((r) => setImmediate(r));
    for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
    expect(done).toBe(true);
    expect(settled).toBe(false);
    expect(w.writes.at(-1)!.message).toBe('Done: 2 seen, 1 planned, 0 missed. Press q to close; everything is removed.');
    expect(w.writes.every((s) => s.keys === true)).toBe(true);   // attached: the keys line stays, q close at the end
    w.queue('quit');
    const r = await run;
    expect(r.quit).toBe(true);
    expect(r.stopped).toBeNull();   // q after the last step is the end, not a stop
    expect(r.end).toBe('Done: 2 seen, 1 planned, 0 missed');
  });

  it('--close-after: attached, the window closes by itself that long after the last step, as a normal end (not a stop)', async () => {
    let doneAt = -1;
    const w = world({ onWrite: (s, w) => { if (s.message.startsWith('Done:')) doneAt = w.slept; } });
    const r = await conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: true, closeAfter: 5 });
    expect(w.writes.at(-1)!.message).toBe('Done: 2 seen, 1 planned, 0 missed. It closes in 5 s, or press q; everything is removed.');
    expect(w.slept - doneAt).toBeGreaterThanOrEqual(5000);
    expect(w.slept - doneAt).toBeLessThan(5500);
    expect(r).toMatchObject({ quit: false, stopped: null, counts: { seen: 2, planned: 1, missed: 0 } });
  });

  it('waits for each developer\'s prompt before typing the first ask', async () => {
    let shown = false;
    const w = world({ onSleep: (w) => { if (w.slept >= 500 && !shown) { shown = true; w.panes.ana = 'ana\n› '; } } });
    w.panes.ana = '';
    await conduct(scenes(), w.io, { mode: 'auto', pace: 0, attached: false });
    expect(shown).toBe(true);
    expect(w.typed).toHaveLength(4);
  });
});

describe('the scene loader', () => {
  it('loads the test scene, its skill folders next to it (refusals: demo-scenes.test.ts)', () => {
    expect(scenes().steps.map((s) => s.id)).toEqual([1, 2, 3]);
  });
});

describe('the conductor reads the assistant\'s wrapped lines as one', () => {
  it('joins a line that goes on under the gutter, so an expected text split by the pane\'s width still counts', () => {
    const pane = '● diff_shared_skill_versions  x v1 → v2\n  │ release v1 -> v2: 1 file(s) changed. Can run something\n  │ new on this machine: yes, because\n› ';
    expect(joined(pane)).toContain('Can run something new on this machine: yes');
    expect(joined('› ask\n● tool')).toBe('› ask\n● tool');   // other lines stay apart
  });
});

describe('the director copies each developer\'s skill folders into their own folder, and only there', () => {
  it('refuses a destination outside work (a developer id that is a path) and a skill folder that is a link', () => {
    const root = scratch('qa-demo-copy-');
    const from = fixture('skills'), work = join(root, 'work');
    const one = (id: string, skills: string[]) => ({ developers: [{ id, title: id, skills }], steps: [] }) as Scenes;
    expect(() => copySkills(one('..', ['hello']), from, work)).toThrow(/outside/);
    expect(() => copySkills(one('ana', ['../hello']), from, work)).toThrow(/outside/);
    expect(existsSync(join(root, 'skills'))).toBe(false);
    const links = join(root, 'links');
    mkdirSync(links);
    symlinkSync(join(from, 'hello'), join(links, 'hello'));
    expect(() => copySkills(one('ana', ['hello']), links, work)).toThrow(/a link/);
    copySkills(one('ana', ['hello']), from, work);
    expect(existsSync(join(work, 'ana', 'skills', 'hello', 'SKILL.md'))).toBe(true);
  });

  it('refuses a skill folder with a symbolic link anywhere inside, saying which, before anything of it is copied', () => {
    const root = scratch('qa-demo-copy-');
    const from = join(root, 'skills'), work = join(root, 'work');
    cpSync(fixture('skills/hello'), join(from, 'hello'), { recursive: true });
    mkdirSync(join(from, 'hello', 'deep'));
    symlinkSync('/etc/hosts', join(from, 'hello', 'deep', 'hosts'));
    const one = { developers: [{ id: 'ana', title: 'ana', skills: ['hello'] }], steps: [] } as unknown as Scenes;
    expect(() => copySkills(one, from, work)).toThrow(`${join(from, 'hello', 'deep', 'hosts')}: a symbolic link; skill folders are copied with real files and folders only`);
    expect(existsSync(join(work, 'ana', 'skills', 'hello'))).toBe(false);
  });
});

describe('the director kills only its own leftovers', () => {
  it('a pane\'s group is killed while it still holds one of the run\'s processes, whether or not the pane\'s own program is alive', () => {
    const listed = (pids: number[]) => () => pids.map((pid) => ({ pid, command: 'node' }));
    const groups = (m: Record<number, number>) => () => new Map(Object.entries(m).map(([pid, g]) => [+pid, g]));
    // group 10: its leader (the stand-in) ended, its server (11) still runs; group 20 has no run process left
    expect(leftoverGroups([10, 20, 30], 'run-1', listed([11, 31]), groups({ 11: 10, 31: 99 }))).toEqual([10]);
    expect(leftoverGroups([10, 20], 'run-1', listed([]), groups({}))).toEqual([]);   // emptied: its id may be someone else's now
    expect(leftoverGroups([10], undefined, listed([11]), groups({ 11: 10 }))).toEqual([]);   // no run id: nothing is known to be ours
  });

  it.skipIf(process.platform !== 'darwin')('with real processes: a group whose leader ended but whose child carries the run\'s id is found; another isn\'t', async () => {
    const id = `20260929T000000Z-${process.pid.toString(16).padStart(8, '0').slice(-8)}`;
    // a leader of its own group (as tmux makes each pane's program) starts a child with the run's id, then ends: node,
    // as the stand-in and its catalog server are
    const script = `const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { env: { PATH: '/usr/bin:/bin', QA_RUN_ID: ${JSON.stringify(id)} }, stdio: 'ignore' }); console.log(c.pid); c.unref();`;
    const leader = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const exited = new Promise((ok) => leader.on('exit', ok));   // listened for at once: it ends right after its line
    const child = pidFrom(await new Promise<string>((ok) => leader.stdout!.once('data', (b) => ok(String(b)))));
    // Only while it's still this run's process: once gone, its number may be someone else's.
    onTestFinished(() => { if (child && runProcesses(id).some((p) => p.pid === child)) { try { process.kill(child, 'SIGKILL'); } catch { /* gone */ } } });
    expect(child).toBeGreaterThan(0);
    await exited;
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { detached: true, stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    onTestFinished(() => { other.kill('SIGKILL'); });
    await new Promise((r) => setTimeout(r, 300));   // both are sleeping by now
    expect(leftoverGroups([leader.pid!, other.pid!], id)).toEqual([leader.pid]);
    expect(signalGroup(leader.pid!, 'SIGKILL', leader)).toBe(true);   // the child goes with its group
    for (let i = 0; i < 40 && running(child!); i++) await new Promise((r) => setTimeout(r, 50));
    expect(running(child!)).toBe(false);
  }, 30_000);
});

describe('a zombie counts as gone', () => {
  it('running() is false for a process that ended but was never reaped (as in a container without an init)', async () => {
    // sh starts a short sleep, prints its pid, then becomes a long sleep that never reaps it: a zombie for a while
    const parent = spawn('/bin/sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    onTestFinished(() => { parent.kill('SIGKILL'); });
    const pid = Number(await new Promise<string>((ok) => parent.stdout!.once('data', (b) => ok(String(b).trim()))));
    expect(running(pid)).toBe(true);
    let zombie = false;
    for (let waited = 0; waited < 3000 && !zombie; waited += 50) {
      await new Promise((ok) => setTimeout(ok, 50));
      zombie = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');
    }
    expect(zombie, 'the short sleep became a zombie').toBe(true);
    expect(running(pid)).toBe(false);
    expect(running(parent.pid!)).toBe(true);
  });

  it('running() asks ps by its path: a PATH without ps (or with another one first) changes nothing', async () => {
    const parent = spawn('/bin/sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
    onTestFinished(() => { parent.kill('SIGKILL'); });
    const pid = Number(await new Promise<string>((ok) => parent.stdout!.once('data', (b) => ok(String(b).trim()))));
    let zombie = false;
    for (let waited = 0; waited < 3000 && !zombie; waited += 50) {
      await new Promise((ok) => setTimeout(ok, 50));
      zombie = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim().startsWith('Z');
    }
    expect(zombie, 'the short sleep became a zombie').toBe(true);
    // a ps planted first on PATH would say "running"; with none on PATH, ps by name can't be asked at all
    const bin = scratch('qa-fake-ps-');
    writeFileSync(join(bin, 'ps'), '#!/bin/sh\necho S\n');
    chmodSync(join(bin, 'ps'), 0o755);
    const saved = process.env.PATH;
    onTestFinished(() => { process.env.PATH = saved; });
    for (const path of [bin, scratch('qa-empty-bin-')]) {
      process.env.PATH = path;
      expect(running(pid), path).toBe(false);
    }
    process.env.PATH = saved;
  });
});
