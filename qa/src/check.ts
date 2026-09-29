// The before/after check (the QA plan §6.6): folders as well as files, in the places a run could write outside its
// sandbox. Other live sessions write under ~/.claude all the time, so it looks only at entries a run could create: the user
// skills folder, project, tmp and cache folders named after this sandbox, this run's session envs, the product's default places,
// in ~/.claude.json and settings.json only the keys a run could add, and the run's processes and listening ports (every
// process a run starts carries its QA_RUN_ID). Any difference fails the run. It only reads.
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { slug } from './leftovers.ts';
import { pidFrom } from './pids.ts';
import type { Machine, Roots } from './machine.ts';

export type Watch = Roots & {
  claudeJson: string;            // ~/.claude.json
  settingsJson: string;          // ~/.claude/settings.json
  productDefaults: string[];     // where the product writes when nothing points it elsewhere
  sandboxRoot: string;           // names in projects/ and the tmp folder are matched by this path's slug
  runId?: string;                // processes carrying QA_RUN_ID=<runId>, and the ports they listen on
  sessions: string[];            // this run's assistant sessions
  processGroups: number[];       // this run's process groups
  productRepo?: string;          // the product repo checkout (assistants tried to patch a crashed tool: agent-experience.md, 'Internal errors: no traceback')
  toolFiles?: string[];          // the installed tool's files
  tools?: Tools;                 // ps and lsof (DEFAULT_TOOLS unless a test swaps one)
};

/** ps and lsof by their full paths, never whichever copy PATH finds first, and found when a run's PATH has none (macOS
 *  and Linux keep them in different places). A path that isn't there makes the check blind, and a run is refused. On
 *  Linux, a run's processes are listed from /proc (`proc`) instead of ps, whose -E (the environment) is BSD's. */
export type Tools = { ps: string; lsof: string; proc?: string };
const system = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? paths[0]!;
export const PS = system('/bin/ps', '/usr/bin/ps');
/** The tools for a platform: on Linux, a run's processes come from /proc. */
export const toolsFor = (platform: NodeJS.Platform): Tools => ({ ps: PS, lsof: system('/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof'), ...(platform === 'linux' ? { proc: '/proc' } : {}) });
export const DEFAULT_TOOLS: Tools = toolsFor(process.platform);
/** Whether the check lists a run's processes on this platform (macOS with ps -E, Linux from /proc). */
export const checksProcesses = (platform: NodeJS.Platform): boolean => platform === 'darwin' || platform === 'linux';

/** The check can't see this machine's processes or ports: a run is refused, never passed blind. */
export class CheckBlind extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckBlind';
  }
}

function run(path: string, args: string[], ok: (status: number) => boolean): SpawnSyncReturns<string> {
  const r = spawnSync(path, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status === null || !ok(r.status)) {
    const why = r.error ? ((r.error as NodeJS.ErrnoException).code ?? r.error.message) : `exit ${r.status ?? r.signal}`;
    throw new CheckBlind(`the before/after check needs ${path} to see what a run leaves behind, and it failed (${why}); nothing was run. Run \`${[path, ...args].join(' ')}\` in a terminal to see why`);
  }
  return r;
}

// The product's default place (the contract §4.5): $SKILLS_HOME and the local catalog live in ~/.skills-catalog/; no XDG
// folders. Installs go to ~/.claude/skills/<name>/, which the check watches anyway.
export const PRODUCT_DEFAULTS = (home: string) => [join(home, '.skills-catalog')];

/** The check's places on a machine, for one run. */
export function watchOn(m: Machine, over: Partial<Watch> & { sandboxRoot: string }): Watch {
  return {
    ...m.roots, claudeJson: join(m.home, '.claude.json'), settingsJson: join(m.roots.claudeDir, 'settings.json'),
    productDefaults: PRODUCT_DEFAULTS(m.home), sessions: [], processGroups: [], ...over,
  };
}

/** What a run could add: whole values under these keys (and, for `projects`, entries for paths in the sandbox).
 *  settings.json: every key (the assistant's own settings: agent-experience.md, 'Name the command in the hand-off prompt').
 *  ~/.claude.json churns with every session, so only the keys a run could add there. */
const JSON_KEYS: Record<'claudeJson' | 'settingsJson', string[] | 'all'> = {
  claudeJson: ['mcpServers', 'autoUpdates', 'autoUpdatesChannel', 'env', 'permissions'],
  settingsJson: 'all',
};
const REPO_SKIP = new Set(['.git', 'node_modules', 'out']);

function walkRepo(dir: string, out: Snapshot): void {
  if (!existsSync(dir)) return;
  for (const n of readdirSync(dir)) {
    if (REPO_SKIP.has(n)) continue;
    const p = join(dir, n);
    if (lstatSync(p).isDirectory()) walkRepo(p, out); else walk(p, out);
  }
}

type Entry = { kind: 'folder' | 'file' | 'key' | 'process' | 'port'; label: string; sig: string };
export type Snapshot = Map<string, Entry>;
export type Difference = { key: string; what: string };

function walk(path: string, out: Snapshot): void {
  let st;
  try { st = lstatSync(path); } catch { return; }
  if (st.isDirectory()) {
    out.set(path, { kind: 'folder', label: path, sig: 'folder' });
    for (const n of readdirSync(path)) walk(join(path, n), out);
  } else {
    const sig = st.isFile() ? `file ${st.size} ${createHash('sha256').update(readFileSync(path)).digest('hex')}` : `other ${st.mode}`;
    out.set(path, { kind: 'file', label: path, sig });
  }
}

function readJson(path: string): Record<string, unknown> {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

/** This user's processes whose environment carries QA_RUN_ID=<runId>. `ps -E` appends a process's environment to its
 *  command line (shown to its owner); the command line without -E is taken off the front, so a mention in the
 *  arguments doesn't count. */
export function runProcesses(runId: string, tools: Tools = DEFAULT_TOOLS): { pid: number; command: string }[] {
  if (tools.proc) return procProcesses(runId, tools.proc);
  const lines = (withEnv: boolean) => {
    const r = run(tools.ps, [...(withEnv ? ['-E'] : []), '-x', '-o', 'pid=,command='], (status) => status === 0);
    return new Map((r.stdout ?? '').split('\n').flatMap((line) => { const m = line.match(/^\s*(\d+) (.*)$/); const pid = m ? pidFrom(m[1]) : undefined; return pid ? [[pid, m![2]] as [number, string]] : []; }));
  };
  const plain = lines(false), full = lines(true);
  const mark = new RegExp(`(^|\\s)QA_RUN_ID=${runId}(\\s|$)`);
  return [...full].flatMap(([pid, line]) => {
    const command = plain.get(pid);
    if (pid === process.pid || command === undefined || !line.startsWith(command)) return [];
    return mark.test(line.slice(command.length)) ? [{ pid, command: command.slice(0, 80) }] : [];
  });
}

/** Linux: this user's processes whose environment holds exactly QA_RUN_ID=<runId>, read from /proc/<pid>/environ (one
 *  NUL-ended entry per variable, readable only for a process of this user's), with the command line from
 *  /proc/<pid>/cmdline. A /proc that can't be listed makes the check blind; a process that ends meanwhile, or can't be
 *  read, isn't listed. */
export function procProcesses(runId: string, proc = '/proc', uid = process.getuid?.()): { pid: number; command: string }[] {
  let names: string[];
  try {
    names = readdirSync(proc);
  } catch (e) {
    throw new CheckBlind(`the before/after check can't list ${proc} (${(e as NodeJS.ErrnoException).code ?? 'error'}), so it can't see what a run leaves behind; nothing was run`);
  }
  const mark = `QA_RUN_ID=${runId}`;
  return names.flatMap((name) => {
    const pid = pidFrom(name);   // never 0
    if (pid === undefined || pid === process.pid) return [];
    try {
      if (statSync(join(proc, name)).uid !== uid) return [];
      if (!readFileSync(join(proc, name, 'environ'), 'utf8').split('\0').includes(mark)) return [];
      const command = readFileSync(join(proc, name, 'cmdline'), 'utf8').split('\0').filter(Boolean).join(' ');
      return [{ pid, command: command.slice(0, 80) }];
    } catch {
      return [];   // ended meanwhile, or not readable
    }
  });
}

/** The TCP ports these processes listen on, and their UDP sockets. lsof exits 1 when it finds none. */
function listening(pids: number[], tools: Tools = DEFAULT_TOOLS): { pid: number; addr: string }[] {
  if (!pids.length) return [];
  const r = run(tools.lsof, ['-nP', '-a', '-p', pids.join(','), '-i', '-F', 'pn'], (status) => status === 0 || status === 1);
  const out: { pid: number; addr: string }[] = [];
  let pid = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && !line.includes('->')) out.push({ pid, addr: line.slice(1) });
  }
  return out;
}

/** Before a run starts, the check proves it can see: a marker process carrying the run's id, listening on a port, must
 *  show up in both. If it doesn't (a sandbox that hides other processes' environments, a missing lsof), the run is
 *  refused, since a process or a port it leaves behind would go unseen. The marker is stopped before anything else. */
export async function checkSees(runId: string, tools: Tools = DEFAULT_TOOLS): Promise<void> {
  // Not installed (common on a minimal Linux): say how to fix it, before anything starts.
  if (!existsSync(tools.lsof)) throw new CheckBlind("this run needs lsof to check that it cleans up after itself, and it isn't installed. Install it (e.g. `sudo apt install lsof`) and run again. Nothing was run");
  const marker = spawn(process.execPath, ['-e', "const s = require('net').createServer().listen(0, '127.0.0.1', () => console.log(s.address().port)); setTimeout(() => process.exit(0), 60000)"], {
    stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, QA_RUN_ID: runId },
  });
  const gone = new Promise((ok) => { marker.once('exit', ok); marker.once('error', ok); });
  try {
    const port = await new Promise<string>((ok, no) => {
      const t = setTimeout(() => no(new CheckBlind("the before/after check's marker process never said its port (10 s); nothing was run")), 10_000);
      marker.once('error', (e) => (clearTimeout(t), no(new CheckBlind(`the before/after check couldn't start its marker process (${(e as NodeJS.ErrnoException).code ?? e.message}); nothing was run`))));
      marker.stdout!.once('data', (b) => (clearTimeout(t), ok(String(b).trim())));
    });
    if (!runProcesses(runId, tools).some((p) => p.pid === marker.pid)) {
      throw new CheckBlind(`the before/after check can't see this run's own marker process with ${tools.proc ?? tools.ps}, so it would miss a process a run leaves behind; nothing was run`);
    }
    if (!listening([marker.pid!], tools).some((l) => l.addr === `127.0.0.1:${port}`)) {
      throw new CheckBlind(`the before/after check can't see the port this run's own marker process listens on with ${tools.lsof}, so it would miss a port a run leaves open; nothing was run`);
    }
  } finally {
    marker.kill('SIGKILL');
    await gone;
  }
}

export function snapshot(w: Watch): Snapshot {
  const out: Snapshot = new Map();
  const prefix = slug(w.sandboxRoot);
  const named = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n === prefix || n.startsWith(prefix + '-')) : []);
  walk(join(w.claudeDir, 'skills'), out);
  for (const n of named(join(w.claudeDir, 'projects'))) walk(join(w.claudeDir, 'projects', n), out);
  for (const id of w.sessions) walk(join(w.claudeDir, 'session-env', id), out);
  for (const n of named(w.claudeTmp)) walk(join(w.claudeTmp, n), out);
  for (const n of named(w.claudeCache)) walk(join(w.claudeCache, n), out);
  for (const p of w.productDefaults) walk(p, out);
  for (const file of ['claudeJson', 'settingsJson'] as const) {
    const data = readJson(w[file]);
    const keys = JSON_KEYS[file] === 'all' ? Object.keys(data) : (JSON_KEYS[file] as string[]);
    for (const k of keys) if (k in data) out.set(`${w[file]}\u0000${k}`, { kind: 'key', label: `${k} in ${w[file]}`, sig: JSON.stringify(data[k]) });
    if (file === 'claudeJson' && data.projects && typeof data.projects === 'object') {
      for (const p of Object.keys(data.projects)) {
        if (p === w.sandboxRoot || p.startsWith(w.sandboxRoot + '/')) out.set(`${w[file]}\u0000projects\u0000${p}`, { kind: 'key', label: `projects[${JSON.stringify(p)}] in ${w[file]}`, sig: 'present' });
      }
    }
  }
  if (w.productRepo) walkRepo(w.productRepo, out);
  for (const p of w.toolFiles ?? []) walk(p, out);
  for (const g of w.processGroups) {
    try { process.kill(-g, 0); out.set(`\u0001pgid ${g}`, { kind: 'process', label: `process group ${g}`, sig: 'running' }); } catch { /* gone */ }
  }
  if (w.runId) {
    const procs = runProcesses(w.runId, w.tools);
    for (const p of procs) out.set(`\u0001proc ${p.pid}`, { kind: 'process', label: `process ${p.pid} from this run`, sig: `running (${p.command})` });
    for (const l of listening(procs.map((p) => p.pid), w.tools)) out.set(`\u0001port ${l.addr}`, { kind: 'port', label: `port ${l.addr}`, sig: `listening (process ${l.pid})` });
  }
  return out;
}

export function compare(before: Snapshot, after: Snapshot): Difference[] {
  const keys = [...new Set([...before.keys(), ...after.keys()])].sort();
  const out: Difference[] = [];
  for (const key of keys) {
    const a = before.get(key), b = after.get(key);
    if (a && b && a.sig === b.sig) continue;
    const e = (b ?? a)!;
    if (e.kind === 'process') { if (b) out.push({ key, what: `${e.label} still ${b.sig}` }); continue; }
    if (e.kind === 'port') { if (b) out.push({ key, what: `${e.label} still ${b.sig}` }); continue; }
    const noun = e.kind === 'key' ? 'key' : e.kind;
    const verb = !a ? 'added' : !b ? 'removed' : 'changed';
    out.push({ key, what: `${verb} ${noun} ${e.label}` });
  }
  return out;
}
