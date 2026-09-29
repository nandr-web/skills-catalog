// The before/after check (the QA plan §6.6): folders as well as files, in the places a run could write outside its
// sandbox. Other live sessions write under ~/.claude all the time, so it looks only at entries a run could create: the user
// skills folder, project and tmp folders named after this sandbox, this run's session envs, the product's default places,
// in ~/.claude.json and settings.json only the keys a run could add, and the run's processes and listening ports (every
// process a run starts carries its QA_RUN_ID). Any difference fails the run. It only reads.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { slug } from './leftovers.ts';
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
};

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
export function runProcesses(runId: string): { pid: number; command: string }[] {
  const lines = (withEnv: boolean) => {
    const r = spawnSync('ps', [...(withEnv ? ['-E'] : []), '-x', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return new Map((r.stdout ?? '').split('\n').flatMap((line) => { const m = line.match(/^\s*(\d+) (.*)$/); return m ? [[Number(m[1]), m[2]] as [number, string]] : []; }));
  };
  const plain = lines(false), full = lines(true);
  const mark = new RegExp(`(^|\\s)QA_RUN_ID=${runId}(\\s|$)`);
  return [...full].flatMap(([pid, line]) => {
    const command = plain.get(pid);
    if (pid === process.pid || command === undefined || !line.startsWith(command)) return [];
    return mark.test(line.slice(command.length)) ? [{ pid, command: command.slice(0, 80) }] : [];
  });
}

/** The TCP ports these processes listen on, and their UDP sockets. */
function listening(pids: number[]): { pid: number; addr: string }[] {
  if (!pids.length) return [];
  const r = spawnSync('lsof', ['-nP', '-a', '-p', pids.join(','), '-i', '-F', 'pn'], { encoding: 'utf8' });
  const out: { pid: number; addr: string }[] = [];
  let pid = 0;
  for (const line of (r.stdout ?? '').split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && !line.includes('->')) out.push({ pid, addr: line.slice(1) });
  }
  return out;
}

export function snapshot(w: Watch): Snapshot {
  const out: Snapshot = new Map();
  const prefix = slug(w.sandboxRoot);
  const named = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((n) => n === prefix || n.startsWith(prefix + '-')) : []);
  walk(join(w.claudeDir, 'skills'), out);
  for (const n of named(join(w.claudeDir, 'projects'))) walk(join(w.claudeDir, 'projects', n), out);
  for (const id of w.sessions) walk(join(w.claudeDir, 'session-env', id), out);
  for (const n of named(w.claudeTmp)) walk(join(w.claudeTmp, n), out);
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
    const procs = runProcesses(w.runId);
    for (const p of procs) out.set(`\u0001proc ${p.pid}`, { kind: 'process', label: `process ${p.pid} from this run`, sig: `running (${p.command})` });
    for (const l of listening(procs.map((p) => p.pid))) out.set(`\u0001port ${l.addr}`, { kind: 'port', label: `port ${l.addr}`, sig: `listening (process ${l.pid})` });
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
