// tmux for the demo: its own server, never the person's. Every call is `tmux -S t -f /dev/null -u …` run in the sandbox
// root: a relative socket (an absolute one can pass macOS's 104-byte limit for socket paths), no config file, UTF-8.
// Client calls add -N, so none of them ever starts a server: only startServer does, in the foreground (-D), which keeps
// it in the director's process group. Only the director and the qa process call tmux; the programs in the panes never do.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { join } from 'node:path';

export const SOCKET = 't';
export const SESSION = 'demo';
const BASE = ['-S', SOCKET, '-f', '/dev/null', '-u'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The tmux every call runs. The qa process finds it once on its PATH and hands the path on: the run's PATH (the
 *  system's folders) may not have it, as with Homebrew's. */
let BIN = 'tmux';
export const useTmux = (path: string) => { BIN = path; };

/** The first executable file named tmux in a PATH's absolute folders, or null. */
export function findTmux(path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(':').filter((d) => d.startsWith('/'))) {
    const p = join(dir, 'tmux');
    try { accessSync(p, constants.X_OK); if (statSync(p).isFile()) return p; } catch { /* not here */ }
  }
  return null;
}

/** `tmux -V`'s answer, or null when there's no tmux. */
export function tmuxVersion(bin: string | null = findTmux()): string | null {
  if (!bin) return null;
  const r = spawnSync(bin, ['-V'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** 3.2 or later (-D, -N, `-l <n>%`). A build from source says "master" and is newer than any release. */
export function versionOk(v: string | null | undefined): boolean {
  if (!v) return false;
  if (/\bmaster\b/.test(v)) return true;
  const m = v.match(/(\d+)\.(\d+)/);
  return !!m && (+m[1] > 3 || (+m[1] === 3 && +m[2] >= 2));
}

export type Tmux = (...args: string[]) => string;

/** Commands to the server whose socket is in `root`; throws with tmux's own words when one fails. */
export function tmuxAt(root: string, env: NodeJS.ProcessEnv = process.env): Tmux {
  return (...args) => {
    const r = spawnSync(BIN, [...BASE, '-N', ...args], { cwd: root, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`tmux ${args[0]}: ${(r.stderr || r.error?.message || `exit ${r.status}`).trim()}`);
    return r.stdout;
  };
}

/** The server, in the foreground: the panes' programs get its environment. */
export const startServer = (root: string, env: NodeJS.ProcessEnv): ChildProcess => spawn(BIN, [...BASE, '-D'], { cwd: root, env, stdio: 'ignore' });

export async function waitForServer(t: Tmux, timeoutMs = 15_000): Promise<void> {
  for (let waited = 0; ; waited += 20) {
    try { t('show-options', '-g', 'status'); return; } catch (e) { if (waited >= timeoutMs) throw e; }
    await sleep(20);
  }
}

/** Several commands in one call (one process, however many commands): tmux reads a lone ";" argument as their end. */
export const batch = (commands: string[][]) => commands.flatMap((c, i) => (i ? [';', ...c] : c));

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** No status bar (it shows the host name and a clock); each pane's title on its top border; a pane whose program ended
 *  stays on screen. No key reaches tmux itself (no detaching, splitting or copy mode): every key goes to the focused
 *  pane, the steps view, except Ctrl-C, which always asks the conductor to quit, whatever state the steps view is in.
 *  Nothing passes between the panes and the person's terminal: no environment from the client that attaches, no
 *  clipboard, no escape sequence passed through, no title set from a pane. */
export function configure(t: Tmux, o: { control: string }): void {
  const options = {
    status: 'off', 'pane-border-status': 'top', 'pane-border-format': ' #{pane_title} ', 'remain-on-exit': 'on', 'history-limit': '10000', 'default-shell': '/bin/sh',
    prefix: 'None', prefix2: 'None', mouse: 'off', 'update-environment': '', 'set-clipboard': 'off',
  };
  t(...batch([
    ...Object.entries(options).map(([k, v]) => ['set-option', '-g', k, v]),
    ['unbind-key', '-a', '-T', 'prefix'], ['unbind-key', '-a', '-T', 'root'],
    ['bind-key', '-T', 'root', 'C-c', 'run-shell', '-b', `printf 'quit\\n' >> ${shq(o.control).replace(/#/g, '##')}`],
  ]));
  // tmux 3.3 and 3.4 added these; an older one has neither, and needs neither
  for (const k of ['allow-passthrough', 'allow-set-title']) { try { t('set-option', '-g', k, 'off'); } catch { /* an older tmux */ } }
}

/** A pane's name (a developer's id, `steps`, `log`) → its tmux pane id. */
export type Panes = Record<string, string>;

/** The window: the developers side by side over 76% of the width, the steps on the right (24%), the log full width along
 *  the bottom (10 rows); titles on the borders; the steps pane focused. Each pane starts with a program that ends at once
 *  (remain-on-exit keeps the pane) until `respawn` starts its own. Hooks put the sizes back after every resize, a
 *  window's or a client's (a terminal that attaches, or changes size). */
export function buildLayout(t: Tmux, o: { developers: { id: string; title: string }[]; size: { cols: number; rows: number }; cwd: string }): Panes {
  const pane = (...args: string[]) => t(...args, '-c', o.cwd, '-P', '-F', '#{pane_id}', '--', 'true').trim();
  const [first, ...others] = o.developers;
  const panes: Panes = { [first.id]: pane('new-session', '-d', '-s', SESSION, '-x', String(o.size.cols), '-y', String(o.size.rows)) };
  panes.log = pane('split-window', '-t', panes[first.id], '-v', '-f', '-l', '10');
  panes.steps = pane('split-window', '-t', panes[first.id], '-h', '-l', '24%');
  let last = first.id;
  others.forEach((d, i) => {   // each takes its share of the pane split off last: 1/2, then 1/3 of 2/3…
    const left = others.length - i;
    panes[d.id] = pane('split-window', '-t', panes[last], '-h', '-l', `${Math.round((100 * left) / (left + 1))}%`);
    last = d.id;
  });
  t(...batch([
    ...o.developers.map((d) => ['select-pane', '-t', panes[d.id], '-T', literal(d.title)]),
    ['select-pane', '-t', panes.steps, '-T', 'Steps'], ['select-pane', '-t', panes.log, '-T', 'Catalog server log'], ['select-pane', '-t', panes.steps],
  ]));
  const share = Math.floor(76 / o.developers.length);
  const sizes = [`resize-pane -t ${panes.log} -y 10`, `resize-pane -t ${panes.steps} -x 24%`, ...o.developers.slice(0, -1).map((d) => `resize-pane -t ${panes[d.id]} -x ${share}%`)].join(' ; ');
  const hooks = ['window-resized', 'client-attached', 'client-resized'];
  try { t(...batch(hooks.map((h) => ['set-hook', '-g', h, sizes]))); } catch {
    for (const h of hooks) { try { t('set-hook', '-g', h, sizes); } catch { /* an older tmux without this hook */ } }
  }
  return panes;
}

/** Start a pane's program, run directly (argv, no shell), in `cwd`. */
export const respawn = (t: Tmux, pane: string, cwd: string, argv: string[]) => { t('respawn-pane', '-k', '-t', pane, '-c', cwd, '--', ...argv); };

/** A pane's text, without colours, wrapped lines joined: from the start of its scrollback, or its screen only. */
export const capturePane = (t: Tmux, pane: string, history: boolean) => t('capture-pane', '-p', '-J', '-t', pane, ...(history ? ['-S', '-'] : []));

/** tmux reads an argument that ends in ";" as the end of a command; "\;" is a literal one. */
export const literal = (s: string) => (s.endsWith(';') ? `${s.slice(0, -1)}\\;` : s);

/** Type `text` into a pane like a person: a few characters every `chunkMs` (all at once when 0), then Enter. */
export async function typeInto(t: Tmux, pane: string, text: string, chunkMs: number): Promise<void> {
  const chars = [...text];
  const size = chunkMs ? 3 : Math.max(1, chars.length);
  for (let i = 0; i < chars.length; i += size) {
    if (i) await sleep(chunkMs);
    t('send-keys', '-t', pane, '-l', '--', literal(chars.slice(i, i + size).join('')));
  }
  t('send-keys', '-t', pane, 'Enter');
}

/** Wait until a client shows the session: an attached run plays only once someone can see it. */
export async function waitForClient(t: Tmux, timeoutMs = 30_000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (t('list-clients', '-t', SESSION, '-F', '#{client_name}').trim()) return true;
    await sleep(50);
  }
  return false;
}

/** The qa process's side: wait for the session (never starting a server), then a client on this terminal. */
export async function waitForSession(root: string, env: NodeJS.ProcessEnv, timeoutMs = 30_000): Promise<boolean> {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (spawnSync(BIN, [...BASE, '-N', 'has-session', '-t', SESSION], { cwd: root, env, stdio: 'ignore' }).status === 0) return true;
    await sleep(50);
  }
  return false;
}
export const attachClient = (root: string, env: NodeJS.ProcessEnv): ChildProcess => spawn(BIN, [...BASE, '-N', 'attach-session', '-t', SESSION], { cwd: root, env, stdio: 'inherit' });
