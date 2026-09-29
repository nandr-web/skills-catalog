// The demo's director. `qa demo` runs it inside qa run, in the run's sandbox: it copies each developer's skill folders into
// their own folder, starts the demo's own tmux server, builds the window, starts the panes' programs, plays the scene
// with the conductor, saves each pane's text to <out>, and stops the server. Exit: 0 nothing missed, 1 a step missed
// (or it failed: <out>/error.txt says why), 130 stopped (q or Ctrl-C in the window before the last step, SIGTERM,
// SIGINT). It deletes nothing: the run's teardown does.
// Also here, for the qa process: the pre-flight, and the window of an attached run.
import { spawnSync, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { PS, runProcesses } from '../check.ts';
import type { RunResult } from '../run.ts';
import { conduct, initialSteps, type ConductorIo, type StepsFile, type Turn } from './conductor.ts';
import { loadScenes, type Scenes } from './scenes.ts';
import { attachClient, buildLayout, capturePane, configure, markReady, respawn, SESSION, startServer, tmuxAt, typeInto, useTmux, versionOk, waitForClient, waitForServer, waitForSession, type Panes, type Tmux } from './tmux.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export const DIRECTOR = here('director.ts');
export const PANE_PATH = '/usr/bin:/bin';
export const DEFAULTS = { scenes: here('../../demo/scenes.yaml'), assistant: here('assistant.ts'), stepsView: here('steps-view.ts'), core: here('../../../core'), client: here('../../../client') };
/** The scene file, the programs the panes run, the core the pre-flight checks and the client whose server is the
 *  default: the tests' own (DEMO_SCENES, DEMO_ASSISTANT, DEMO_STEPS_VIEW, DEMO_CORE, DEMO_CLIENT) only on a fake
 *  machine, so a setting left in a shell never swaps a real run's scenes or programs. */
export function demoPaths(env: NodeJS.ProcessEnv, fakeMachine: boolean): { scenes: string; assistant: string; stepsView: string; core: string; client: string } {
  const pick = (k: string, fallback: string) => resolve((fakeMachine && env[k]) || fallback);
  return {
    scenes: pick('DEMO_SCENES', DEFAULTS.scenes),
    assistant: pick('DEMO_ASSISTANT', DEFAULTS.assistant), stepsView: pick('DEMO_STEPS_VIEW', DEFAULTS.stepsView), core: pick('DEMO_CORE', DEFAULTS.core),
    client: pick('DEMO_CLIENT', DEFAULTS.client),
  };
}
/** This repository's own catalog MCP server (<client>/src/cli.ts mcp, run by this node), once its dependencies are
 *  installed: the demo's default. As a JSON array of its words, so a path with a space stays one word. */
export function repoServer(client = DEFAULTS.client): string | undefined {
  return existsSync(join(client, 'node_modules')) ? JSON.stringify([process.execPath, join(client, 'src', 'cli.ts'), 'mcp']) : undefined;
}
/** The log pane's first line, dimmed, with the core in the stand-ins (--core): they write the log, not a server. */
export const LOG_NOTE = "The stand-in assistants write this log (--core); by default the catalog's server does.";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** A process that exists and hasn't ended. A zombie (ended, not yet reaped: a container without an init leaves them)
 *  counts as gone; if ps can't say, it counts as running. */
export function running(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  const r = spawnSync(PS, ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  return !!r.error || !r.stdout.trim().startsWith('Z');
}

/** Node 24.15 or later, as package.json's engines say (the demo's programs need what it added). */
export function nodeOk(v: string): boolean {
  const m = v.match(/^v?(\d+)\.(\d+)/);
  return !!m && (+m[1] > 24 || (+m[1] === 24 && +m[2] >= 15));
}

export type Preflight = { tmux: string | null; coreDir: string; tty: boolean; headless: boolean; live: boolean; node?: string };
/** What stops the demo before anything starts, one plain line each (the qa process prints them and exits 3). */
export function preflight(o: Preflight): string[] {
  const node = o.node ?? process.versions.node;
  return [
    ...(nodeOk(node) ? [] : [`needs Node 24.15 or later (this is Node ${node})`]),
    ...(versionOk(o.tmux) ? [] : ['needs tmux 3.2 or later']),
    ...(existsSync(join(o.coreDir, 'node_modules')) ? [] : ['run npm ci --ignore-scripts in ../core first']),
    ...(o.tty || o.headless ? [] : ['needs a terminal: run it in one, or add --headless']),
    ...(o.live ? ['not yet: real assistants in the panes come later'] : []),
  ];
}

/** An attached run has no time limit (the person has q and Ctrl-C); a headless one keeps qa run's. */
export const demoTimeoutMs = (headless: boolean): number | undefined => (headless ? undefined : Infinity);

/** A demo run's ending, from qa run's and what the director left in <out>. A director that wrote no summary failed
 *  (exit 1), whatever its exit code (a pass without one is impossible to trust), and `note` says so when it wrote no
 *  error.txt either; a timeout, a stop or something left behind keeps its own ending. With a summary that says the
 *  person stopped it (q or Ctrl-C before the last step), the run was interrupted (130), neither a pass nor a fail. */
export function demoEnding(r: RunResult, o: { summary: boolean; stopped: boolean; error?: boolean }): { ended: RunResult; note?: string } {
  if (!o.summary && (r.status === 'pass' || r.status === 'fail')) {
    return { ended: { ...r, status: 'fail', exitCode: 1 }, ...(o.error ? {} : { note: 'the director wrote no summary' }) };
  }
  return { ended: o.stopped && r.status === 'fail' ? { ...r, status: 'interrupted' } : r };
}

/** `<columns>x<rows>`, at least 80x24. */
export function parseSize(s: string): { cols: number; rows: number } | undefined {
  const m = s.match(/^(\d+)x(\d+)$/);
  return m && +m[1] >= 80 && +m[2] >= 24 ? { cols: +m[1], rows: +m[2] } : undefined;
}

/** The catalog MCP server's command (--server, and DEMO_MCP in the panes): its words, split at spaces with no shell (so
 *  quotes, $ and ; are just characters), or a JSON array of them (for a path with a space); the first an absolute path:
 *  nothing is found on a PATH. */
export function serverCommand(line: string): string[] {
  let argv: string[];
  if (line.trim().startsWith('[')) {
    let words: unknown;
    try { words = JSON.parse(line); } catch { throw new Error('the server command starts with [ but is not a JSON array'); }
    if (!Array.isArray(words) || !words.every((w) => typeof w === 'string' && w !== '')) throw new Error('the server command as JSON must be an array of words');
    argv = words;
  } else argv = line.trim().split(/\s+/).filter(Boolean);
  if (!argv.length) throw new Error('the server command is empty');
  if (!isAbsolute(argv[0])) throw new Error(`the server command must start with an absolute path (${argv[0]} isn't one)`);
  return argv;
}

/** The qa process's side of an attached run: once the session is up, a tmux client on this terminal, in the foreground.
 *  It's the qa process's own child, not the run's (no QA_RUN_ID), and ends when the director stops the server. If it
 *  ends while the run goes on (the client was killed), the run is stopped: nobody could press q any more. */
export async function showWindow(root: string, env: NodeJS.ProcessEnv, stop: () => void, running: () => boolean): Promise<void> {
  if (!(await waitForSession(root, env, 30_000, running))) return;
  const client = attachClient(root, env);
  await new Promise((ok) => client.on('exit', ok).on('error', ok));
  if (running()) setTimeout(() => { if (running()) stop(); }, 5000).unref();
}

/** A new file in <out>: never over one that is there (the qa process checked it was empty). */
const writeNew = (file: string, text: string) => writeFileSync(file, text, { flag: 'wx' });

/** A file written whole: a temp file, then a rename. */
function writeWhole(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
/** A file's complete lines (a line still being written has no newline yet). */
const lines = (file: string) => { const t = readFileSync(file, 'utf8'); return t.slice(0, t.lastIndexOf('\n') + 1).split('\n').filter(Boolean); };

/** Refuses a symbolic link (or anything but a file or a folder) anywhere in a skill folder, by lstat, naming it. */
function realFilesOnly(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name), st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${p}: a symbolic link; skill folders are copied with real files and folders only`);
    if (st.isDirectory()) realFilesOnly(p);
    else if (!st.isFile()) throw new Error(`${p}: not a file or a folder; skill folders are copied with real files and folders only`);
  }
}

/** Each developer's skill folders, from the scene's skills/ folder into the folder their assistant runs in, and only
 *  there: a destination outside `work`, a skill folder that is a link, or one with a link inside, is refused before
 *  anything is copied for it. */
export function copySkills(scenes: Scenes, from: string, work: string): void {
  const inside = (p: string) => p.startsWith(resolve(work) + sep);
  for (const d of scenes.developers) {
    const skills = resolve(work, d.id, 'skills');
    if (!inside(skills)) throw new Error(`${d.id}: its skills would be copied outside ${work}`);
    mkdirSync(skills, { recursive: true });
    for (const f of d.skills) {
      const to = resolve(skills, f);
      if (!inside(to) || dirname(to) !== skills) throw new Error(`${d.id}: ${f} would be copied outside ${skills}`);
      if (!lstatSync(join(from, f), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${join(from, f)}: no skill folder there (a link isn't one)`);
      realFilesOnly(join(from, f));
      cpSync(join(from, f), to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
    }
  }
}

// What the director started, for stopping it on every ending.
let server: ChildProcess | undefined, t: Tmux | undefined, panePids: number[] = [];

/** Each process's group, by the system's ps. */
function processGroups(pids: number[]): Map<number, number> {
  if (!pids.length) return new Map();
  const r = spawnSync(PS, ['-o', 'pid=,pgid=', '-p', pids.join(',')], { encoding: 'utf8' });
  return new Map((r.stdout ?? '').split('\n').flatMap((l) => { const m = l.trim().match(/^(\d+)\s+(\d+)$/); return m ? [[+m[1], +m[2]] as [number, number]] : []; }));
}

/** The panes' process groups (each pane's program leads one: its pid at start is the group's id) that still hold one of
 *  this run's processes, as the run's own check lists them (QA_RUN_ID in their environment): a stand-in's catalog server
 *  stays in its group after the stand-in ends. A group id can't be reused while the group has a member, so a group
 *  found here is the pane's own; an emptied group is left alone. */
export function leftoverGroups(groups: number[], runId: string | undefined, list = runProcesses, groupOf = processGroups): number[] {
  if (!runId || !groups.length) return [];
  const members = list(runId).map((p) => p.pid);
  const of = groupOf(members);
  return groups.filter((id) => members.some((pid) => of.get(pid) === id));
}

/** Stop the server; the panes' programs get SIGHUP from it. After 2 s, every pane's group that still holds one of the
 *  run's processes is killed, whether or not the pane's own program is still running. */
async function stopServer(): Promise<void> {
  try { t?.('kill-server'); } catch { /* already gone */ }
  for (let waited = 0; waited < 2000 && server?.exitCode === null && server.signalCode === null; waited += 20) await sleep(20);
  if (server?.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  for (let waited = 0; waited < 2000 && panePids.some(running); waited += 50) await sleep(50);
  for (const id of leftoverGroups(panePids, process.env.QA_RUN_ID)) { try { process.kill(-id, 'SIGKILL'); } catch { /* gone */ } }
}

async function main(argv: string[]): Promise<number> {
  const started = Date.now(), timing: Record<string, number> = {};
  const mark = (what: string) => { timing[what] = Date.now() - started; };
  const { values: v } = parseArgs({ args: argv, options: {
    scenes: { type: 'string' }, tmux: { type: 'string' }, assistant: { type: 'string' }, 'steps-view': { type: 'string' }, out: { type: 'string' },
    pace: { type: 'string', default: '3' }, size: { type: 'string', default: '200x50' }, only: { type: 'string' }, step: { type: 'boolean' }, headless: { type: 'boolean' },
    'close-after': { type: 'string' },
    server: { type: 'string' },
  } });
  const root = process.env.QA_SANDBOX;
  const size = parseSize(v.size);
  if (!root || !v.tmux || !v.scenes || !v.assistant || !v['steps-view'] || !v.out || !size) throw new Error('the director runs inside qa demo, which gives it its flags');
  if (v.server !== undefined) serverCommand(v.server);
  const demo = join(root, 'demo');
  mkdirSync(demo);
  const files = { activity: join(demo, 'activity.log'), turns: join(demo, 'turns.jsonl'), steps: join(demo, 'steps.json'), control: join(demo, 'control') };
  for (const f of [files.activity, files.turns, files.control]) writeFileSync(f, '');
  const scenes = loadScenes(v.scenes);
  copySkills(scenes, join(dirname(v.scenes), 'skills'), join(root, 'work'));
  const pace = Number(v.pace), mode = v.step && !v.headless ? 'step' : 'auto';

  // The server's environment is every pane's: the sandbox's own home (never the real one: the scripted assistants need
  // no login), a PATH of the system's folders only (the panes run node, sh and tail by path; programs installed
  // elsewhere aren't found by name, but the system's are, tmux among them on Linux: the pane programs start nothing but
  // the catalog's MCP server, by its path, which meta.test.ts checks), where the activity log goes, the scene file, the
  // pace, and the catalog MCP server the stand-ins call (DEMO_MCP, only with --server; without, the core in their own
  // process).
  useTmux(v.tmux);
  const { DEMO_MCP: _unused, ...inherited } = process.env;
  const env = { ...inherited, HOME: join(root, 'home'), PATH: PANE_PATH, SKILLS_ACTIVITY_LOG: files.activity, DEMO_SCENES: v.scenes, DEMO_PACE: String(pace), ...(v.server !== undefined ? { DEMO_MCP: v.server } : {}) };
  mark('copied');
  server = startServer(root, env);
  t = tmuxAt(root, env);
  await waitForServer(t);
  mark('server');
  configure(t, { control: files.control });
  const panes: Panes = buildLayout(t, { developers: scenes.developers, size, cwd: demo });
  mark('window');
  writeWhole(files.steps, JSON.stringify(initialSteps(scenes, mode)));
  for (const d of scenes.developers) respawn(t, panes[d.id], join(root, 'work', d.id), [process.execPath, v.assistant, '--as', d.id]);
  respawn(t, panes.steps, demo, [process.execPath, v['steps-view']]);
  // The log as it grows. With the core in the stand-ins, they write it: a note first says so (sh gets both as
  // arguments: nothing is put into its script). With --server, the catalog's servers write it, as its title says.
  if (v.server === undefined) respawn(t, panes.log, demo, ['/bin/sh', '-c', 'printf "\\033[2m%s\\033[0m\\n" "$1"; exec /usr/bin/tail -n +1 -F "$2"', 'log', LOG_NOTE, files.activity]);
  else respawn(t, panes.log, demo, ['/usr/bin/tail', '-n', '+1', '-F', files.activity]);
  panePids = t('list-panes', '-t', SESSION, '-F', '#{pane_pid}').trim().split('\n').map(Number);
  mark('programs');
  markReady(t);   // the window is whole: only now may a client attach and draw it
  // attached, the steps start once the window shows (a person, or a loaded machine, may take a while to open it)
  if (!v.headless && !(await waitForClient(t))) throw new Error('no window opened on the demo within 30 s');
  mark('client');

  let controlAt = 0;
  const tm = t;
  const io: ConductorIo = {
    type: (who, text, instant) => typeInto(tm, panes[who], text, instant ? 0 : 15),
    capture: (pane) => capturePane(tm, panes[pane], true),
    turns: () => lines(files.turns).flatMap((l) => { try { return [JSON.parse(l) as Turn]; } catch { return []; } }),
    control: () => {
      const text = readFileSync(files.control, 'utf8'), end = text.lastIndexOf('\n') + 1;
      const words = text.slice(controlAt, end).split('\n').map((w) => w.trim()).filter(Boolean);
      controlAt = Math.max(controlAt, end);
      return words;
    },
    writeSteps: (s: StepsFile) => writeWhole(files.steps, JSON.stringify(s, null, 2) + '\n'),
    sleep,
  };
  const closeAfter = v['close-after'] === undefined ? undefined : Number(v['close-after']);
  const r = await conduct(scenes, io, { mode, pace, attached: !v.headless, only: v.only?.split(','), onMark: mark, server: v.server !== undefined, ...(closeAfter === undefined ? {} : { closeAfter }) });
  mark('played');

  // Each pane's text (the steps pane once it shows the end; a narrow pane wraps it), the window's layout, the steps, the
  // log and a summary.
  const flat = (text: string) => text.replace(/\s+/g, ' ');
  for (let waited = 0; waited < 10_000 && !flat(capturePane(t, panes.steps, false)).includes(r.end); waited += 50) await sleep(50);
  mark('drawn');
  const save = (name: string, text: string) => writeNew(join(v.out!, name), text);
  for (const [name, id] of Object.entries(panes)) save(`${name}.txt`, capturePane(t, id, name !== 'steps'));
  save('layout.txt', t('list-panes', '-t', SESSION, '-F', '#{@title} #{pane_left},#{pane_top} #{pane_width}x#{pane_height}'));
  save('steps.json', readFileSync(files.steps, 'utf8'));
  save('activity.log', readFileSync(files.activity, 'utf8'));
  save('summary.json', JSON.stringify({
    run_id: process.env.QA_RUN_ID, quit: r.quit, stopped: r.stopped, counts: r.counts, steps: r.steps,
    socket_path: t('display-message', '-p', '-t', SESSION, '#{socket_path}').trim(), server_pid: server.pid, pane_pids: panePids,
  }, null, 2) + '\n');
  await stopServer();
  mark('stopped');
  save('timing.json', JSON.stringify(timing) + '\n');
  return r.stopped ? 130 : r.counts.missed ? 1 : 0;
}

if (import.meta.main) {
  // A signal stops the server and exits 130; whatever main was doing then fails and is ignored.
  let stopping = false;
  const at = process.argv.indexOf('--out'), out = at > 0 ? process.argv[at + 1] : undefined;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => { if (!stopping) { stopping = true; void stopServer().finally(() => process.exit(130)); } });
  main(process.argv.slice(2)).then((code) => { if (!stopping) process.exit(code); }, async (e) => {
    if (stopping) return;
    if (out && existsSync(out)) { try { writeNew(join(out, 'error.txt'), `${(e as Error).message}\n`); } catch { /* one is there already */ } }
    await stopServer();
    process.exit(1);
  });
}
