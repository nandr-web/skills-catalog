#!/usr/bin/env node
// The stand-in assistant in a developer's pane: no model. A line it knows from the scene file
// becomes the tool calls an assistant would make, on the real catalog, and it prints what the catalog says in the
// product's own words (the core's renderers and the vendored surface). One activity.log line per call and one
// turns.jsonl line per ask; neither ever holds colour. The catalog is behind a Backend: the core in this process, or,
// with DEMO_MCP (qa demo --server), the catalog's MCP server, one per developer, which writes activity.log itself.
//   node src/demo/assistant.ts --as <developer> [--scenes <file>]   (SKILLS_CATALOG and QA_SANDBOX from the demo's sandbox)
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { connect, type McpClient } from '../agent/mcp-client.ts';
import type { Catalog } from '../../../core/src/catalog.ts';
import { CatalogError } from '../../../core/src/errors.ts';
import { actAs } from '../../../core/src/local/identity.ts';
import type { Ids } from '../../../core/src/ports.ts';
import { renderDiff, renderError, renderRead, renderSearch, renderVersions } from '../../../core/src/render.ts';
import { flagText } from '../../../core/src/skill-tree/diff.ts';
import { Surface } from '../../../core/src/surface.ts';
import { PANE_PATH, serverCommand } from './director.ts';
import { CLI_OPS, findAsk, loadScenes, SCENES_FILE, ScenesError, type Call, type Scenes } from './scenes.ts';

const GREEN = '\x1b[32m', ORANGE = '\x1b[38;5;208m', DIM = '\x1b[2m', RESET = '\x1b[0m';
/** What goes before each line of the product's words; the conductor joins a line that goes on under it. */
export const GUTTER = '  │ ';
/** How the stand-in's own unexpected error starts (it isn't the catalog's answer, so it has no gutter). */
export const STAND_IN_ERROR = '✗ stand-in error: ';
const paint = (colour: string, s: string) => `${colour}${s}${RESET}`;

export type Op = Exclude<Call, { planned: string }>;
/** What a call shows: the text, the lines to colour orange, its activity.log words (none when the server logs it), and
 *  the call it leads to, if any (publish's confirm after its preview), made once the person says yes to `yes`. */
export type Reply = {
  text: string; alert?: number[]; log?: { target: string; result: string };
  /** The call wrote to the pane itself (the command line, in the person's own terminal): nothing more to show. */
  shown?: boolean;
  next?: { tool: string; args: string; yes: string; call: () => Promise<Reply> };
};
/** The catalog, as the stand-in calls it. A refusal (not_owner, not_found…) is a reply; only an unexpected error throws.
 *  `logs`: the catalog writes activity.log itself (the MCP server), so the stand-in writes only its planned lines.
 *  `close`: stops what it started. */
export interface Backend { call(who: string, c: Op): Promise<Reply>; readonly logs?: boolean; readonly runsCli?: boolean; close?(): void }
/** The pane's terminal, lent to the command line for the person's own turn: the stand-in stops reading it meanwhile. */
export type Terminal = { pause(): void; resume(): void };

/** What the core in the stand-in's process shows for a command-line op: it runs only on the catalog's server. */
export const CLI_PLANNED: Record<string, string> = {
  install: 'shown with the catalog\'s server (run without --core)',
  update: 'shown with the catalog\'s server (run without --core): risky updates are held until you say yes',
  accept: 'shown with the catalog\'s server (run without --core): risky updates are held until you say yes',
};

export type Stage = {
  who: string;
  scenes: Scenes;
  backend: Backend;
  surface: Surface;
  /** The pane (ANSI colours included). */
  out: (text: string) => void;
  /** The pane's width in columns: the product's lines wrap at it (0 or none: no wrapping). A function is asked each time
   *  an answer is shown, so a pane resized after the stand-in started still fits. */
  width?: number | (() => number);
  /** $QA_SANDBOX/demo: turns.jsonl, and activity.log unless logFile says otherwise. */
  demoDir: string;
  logFile?: string;
  /** Milliseconds before each call. */
  pace?: number;
  now?: () => Date;
};
export type Turn = { who: string; say: string; step: number | null; ok: boolean; at: string };

/** A scene's op as this surface's tool name; setup is the command, until the installer serves it. */
export function toolName(s: Surface, op: string): string {
  if (op === 'setup') return `${s.cli} setup`;
  const name = s.names[op === 'read' ? 'get' : op];
  if (!name) throw new Error(`the surface has no tool for ${op}`);
  return name;
}

/** The activity log's words: the surface's own (its top-level `log` section), read as the catalog's server reads them
 *  (client/src/activity.ts), so both backends log the same words: a search's target, a result by operation (and
 *  outcome), an error by code, and the result column's width (the longest of them). */
export function logWords(s: Surface) {
  const log = s.fill(s.doc.log) as { search_target: string; result: Record<string, string | Record<string, string>>; error: Record<string, string> };
  const all = [...Object.values(log.result).flatMap((w) => (typeof w === 'string' ? [w] : Object.values(w))), ...Object.values(log.error)];
  return {
    width: Math.max(...all.map((w) => w.length)),
    searchTarget: (count: number, total: number) => s.format(log.search_target, { count, total }),
    result: (op: string, outcome?: string): string => {
      const w = log.result[op];
      const word = typeof w === 'string' ? w : outcome === undefined ? undefined : w?.[outcome];
      if (word === undefined) throw new Error(`the surface's log has no result for ${op}${outcome ? ` (${outcome})` : ''}`);
      return word;
    },
    // a code the log has no word for shows as refused, with its code (the surface's rule)
    error: (code: string) => log.error[code] ?? `refused: ${code}`,
  };
}
export const RESULT_WIDTH = logWords(Surface.load()).width;

/** One activity.log line: `HH:MM:SS  <who>  <tool:27>  <result, padded>  <target>`, UTC. who is "-" unless a developer,
 *  padded to the longest developer id (at least 4). */
export function logLine(e: { at: Date; who: string; tool: string; target: string; result: string }, developers: string[]): string {
  const one = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ');
  const who = developers.includes(e.who) ? e.who : '-';
  const width = Math.max(4, ...developers.map((d) => d.length));
  return `${e.at.toISOString().slice(11, 19)}  ${who.padEnd(width)}  ${one(e.tool).padEnd(27)}  ${one(e.result).padEnd(RESULT_WIDTH)}  ${one(e.target)}`;
}

/** A skill folder as publish's files, by path; executable files keep their mode. */
export function readFolder(dir: string, sub = ''): { path: string; mode: string; content_base64: string }[] {
  return readdirSync(join(dir, sub)).sort().flatMap((name) => {
    const path = sub ? `${sub}/${name}` : name;
    const st = lstatSync(join(dir, path));
    if (st.isDirectory()) return readFolder(dir, path);
    if (!st.isFile()) return [];
    return [{ path, mode: st.mode & 0o111 ? '0755' : '0644', content_base64: readFileSync(join(dir, path)).toString('base64') }];
  });
}

/** The core, in this process: each developer publishes from their own skill folders. `ids` makes the tokens that fence
 *  a read's and a diff's publisher text (the core's random ones unless a test fixes them). */
export function coreBackend(o: { catalog: Catalog | Promise<Catalog>; surface: Surface; skillsDir: string; ids?: Ids }): Backend {
  const s = o.surface, words = logWords(s);
  // loaded at the first call, as the catalog is: the module opens SQLite, whose warning must not reach the pane first
  const ids = async (): Promise<Ids> => o.ids ?? (await import('../../../core/src/local/index.ts')).randomIds;
  const run = async (who: string, c: Op): Promise<Reply> => {
    const cat = await o.catalog;
    switch (c.op) {
      case 'publish': {
        const r = await cat.publish({ name: c.name, files: readFolder(join(o.skillsDir, c.folder)), ...(c.message ? { message: c.message } : {}) }, actAs(who));
        if (!r.created) return { text: s.format(s.word('publish.identical'), { folder: c.folder, name: r.name, latest: r.version }), log: { target: `${r.name} v${r.version}`, result: words.result('publish', 'identical') } };
        // The surface's words for a publish, then what the catalog flagged, in the review notes a publish preview shows
        // (orange: it can run something, or grants something).
        const notes = r.risk_flags.map((f) => {
          const note = s.word(`quality.note.${f.kind}`);
          return typeof note === 'string' ? s.format(note, { path: flagText(f.path ?? ''), detail: flagText(f.detail) }) : f.kind;
        });
        return {
          text: [s.format(s.word('publish.published'), { name: r.name, version: r.version }), ...(notes.length ? [s.format(s.word('publish.review'), { notes: notes.join('; ') }).trim()] : [])].join('\n'),
          alert: notes.length ? [1] : [],
          log: { target: `${r.name} v${r.version}`, result: words.result('publish', 'published') },
        };
      }
      case 'search': {
        const req = { query: c.query };
        const r = await cat.search(req);
        return { text: renderSearch(s, r, req), log: { target: words.searchTarget(r.total_matches, r.catalog_size), result: words.result('search', r.match) } };
      }
      case 'read': {
        const r = await cat.read({ name: c.name });
        const items = r.skills.filter((e) => !('error' in e)) as { name: string; version: number }[];
        return { text: renderRead(s, r, await ids()), log: { target: items.map((i) => `${i.name} v${i.version}`).join(', ') || '-', result: words.result('get') } };
      }
      case 'versions': {
        const r = await cat.versions({ name: c.name });
        return { text: renderVersions(s, r), log: { target: `${r.name} v${r.latest}`, result: words.result('versions') } };
      }
      case 'diff': {
        const r = await cat.diff({ name: c.name, from: c.from, to: c.to });
        // Orange: the header when it can run something new, and each file line behind a risk flag.
        const risky = new Set(r.risk_flags.map((f) => f.path));
        const alert = r.risk_flags.length ? [0, ...r.files.flatMap((f, i) => (risky.has(f.path) ? [i + 1] : []))] : [];
        return { text: renderDiff(s, r, await ids()), alert, log: { target: `${r.name} v${r.from} → v${r.to}`, result: words.result('diff', r.risk_flags.length ? 'runnable' : 'text_only') } };
      }
      // The command line's ops run only on the catalog's server; the stand-in shows them as planned here.
      case 'install':
      case 'update':
      case 'accept':
        throw new Error(`${c.op} runs only with the catalog's server (qa demo --server)`);
    }
  };
  return {
    async call(who, c) {
      try {
        return await run(who, c);
      } catch (e) {
        if (!(e instanceof CatalogError)) throw e;
        // A refusal is the catalog's answer, in its words: the first line is the error. Its log target is "-", as the
        // server's is: nothing from the request.
        return { text: renderError(s, e), alert: [0], log: { target: '-', result: words.error(e.code) } };
      }
    },
  };
}

/** A developer's server settings, and nothing else from this process. Each developer is a machine of their own in the
 *  sandbox: their home, the client's folder, and the assistant's home (the product installs to its .claude/skills), all
 *  in it. Only the catalog is shared, and the demo's log, which the log pane shows.
 *  A PATH of the system's folders only: the server is started by path. Any setting that would leave the sandbox is refused. */
export function serverEnv(o: { root: string; who: string; catalog: string; activityLog: string; runId?: string }): Record<string, string> {
  const inside = (p: string) => { const r = relative(resolve(o.root), resolve(p)); return !!r && !r.startsWith('..') && !isAbsolute(r); };
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(o.who)) throw new Error(`${JSON.stringify(o.who)} isn't a developer name a folder in the sandbox can hold`);
  let catalog: string | undefined;
  try { catalog = o.catalog.startsWith('file:') ? fileURLToPath(o.catalog) : undefined; } catch { /* not a file URL */ }
  if (!catalog || !inside(catalog)) throw new Error(`the catalog ${o.catalog} is not a folder in the sandbox (${o.root})`);
  if (!inside(o.activityLog)) throw new Error(`the activity log ${o.activityLog} is not in the sandbox (${o.root})`);
  // The assistant's home is the root its own folders are under (.claude, .claude/skills: contract §8), as HOME is.
  const home = join(o.root, 'home', o.who);
  return {
    PATH: PANE_PATH,
    HOME: home,
    SKILLS_HOME: join(home, '.skills-catalog'),
    SKILLS_CATALOG: o.catalog,
    SKILLS_AS: o.who,
    SKILLS_ACTIVITY_LOG: o.activityLog,
    SKILLS_ASSISTANT_HOME: home,
    // the run's id, so qa run's check after the run finds a server that outlived it
    ...(o.runId && /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(o.runId) ? { QA_RUN_ID: o.runId } : {}),
  };
}

/** The catalog's command line, from its MCP server's command: the same words less the trailing `mcp`, and node started
 *  with its experimental warning off (as the installed command does), so the pane shows only the product's words. */
export function cliCommand(server: readonly string[]): string[] {
  const argv = server.at(-1) === 'mcp' ? server.slice(0, -1) : [...server];
  if (/^node(\.exe)?$/.test(basename(argv[0] ?? '')) && !argv.some((a) => a.startsWith('--disable-warning'))) argv.splice(1, 0, '--disable-warning=ExperimentalWarning');
  return argv;
}

/** The lines of a server's result to colour orange, found by the surface's own words: a refusal's first line; a publish
 *  preview's review line (what the catalog flagged); the diff header that says it can run something new, and the files
 *  listed right under it that can run. */
export function alertLines(s: Surface, text: string, isError: boolean): number[] {
  if (isError) return [0];
  const lines = text.split('\n');
  const review = String(s.word('publish.review')).split('{')[0];
  const reviewed = review ? lines.flatMap((l, i) => (l.startsWith(review) ? [i] : [])) : [];
  return [...reviewed, ...diffAlert(s, lines)];
}
function diffAlert(s: Surface, lines: string[]): number[] {
  const w = s.word('diff');
  const header = String(w.header), at = header.indexOf('{executes}');
  if (at < 0) return [];
  // " file(s) changed. Can run something new on this machine: " + "yes, because "
  const yes = header.slice(header.lastIndexOf('}', at - 1) + 1, at) + String(w.executes_yes).split('{')[0];
  const head = lines.findIndex((l) => l.includes(yes));
  if (head < 0) return [];
  const item = String(w.file).split('{')[0], runs = [String(w.kind.executable), String(w.kind.script)];
  const out = [head];
  for (let i = head + 1; i < lines.length && lines[i]!.startsWith(item); i++) if (runs.some((k) => lines[i]!.endsWith(k))) out.push(i);
  return out;
}

/** The catalog's MCP server for one developer: started at once (the stand-in makes this at its first ask) with `command`
 *  and serverEnv's settings only, in the developer's folder. Each op is one tool call, by the surface's name, shown in the
 *  server's own words (its result's text). Publish is two: the preview, then, once the person says yes, the confirm with
 *  the values the preview gives for it (a refused preview is never confirmed). The server writes activity.log. A server
 *  that won't start, or stops, is each call's error; close() stops it, at any moment. */
export function mcpBackend(o: { command: string[]; root: string; who: string; catalog: string; activityLog: string; surface: Surface; cli?: string[]; terminal?: Terminal }): Backend & { close(): void; pid(): number | undefined } {
  const s = o.surface;
  let child: ChildProcess | undefined, stopped = false;
  // The tools the server serves, each with the inputs it takes (its inputSchema's properties).
  type Tools = Map<string, string[]>;
  const started = (async (): Promise<{ client: McpClient; tools: Tools }> => {
    const client = await connect(o.command, serverEnv({ ...o, runId: process.env.QA_RUN_ID }), { cwd: join(o.root, 'work', o.who), spawned: (p) => { child = p; if (stopped) p.kill(); } });
    const listed = await client.request('tools/list');
    const tools: Tools = new Map((Array.isArray(listed?.tools) ? listed.tools : []).map((t: { name?: unknown; inputSchema?: { properties?: object } }) => [String(t?.name), Object.keys(t?.inputSchema?.properties ?? {})]));
    return { client, tools };
  })();
  started.catch(() => undefined);   // each call says why
  const tool = async (name: string, args: Record<string, unknown>) => {
    const { client, tools } = await started;
    if (!tools.has(name)) throw new Error(`the catalog's server has no tool ${name}`);
    const r = await client.request('tools/call', { name, arguments: args });
    const text = (Array.isArray(r?.content) ? r.content : []).filter((c: { type?: unknown }) => c?.type === 'text').map((c: { text?: unknown }) => String(c.text)).join('\n');
    const isError = r?.isError === true;
    const data = r?.structuredContent && typeof r.structuredContent === 'object' && !Array.isArray(r.structuredContent) ? (r.structuredContent as Record<string, unknown>) : {};
    return { text, isError, alert: alertLines(s, text, isError), data };
  };
  // The confirm call's values, from the preview's own result, never typed here: each input the tool takes that the first
  // call didn't send, the confirm included. From its structured content when it has them; else read from its text as an
  // assistant would, only from its instruction to call the tool (`<tool> with …`) on: the confirm in the stable phrase
  // `confirm "<value>"`, each other input where it gives it as `<input> <JSON value>` (e.g. name "x", version 2, flags
  // ["runnable_file"]: "all exactly as given here"). The folder and the message are never taken from the text (the first
  // call has them), and a preview for another skill than the one asked for is never confirmed.
  const secondCall = async (name: string, skill: string, first: Record<string, unknown>, preview: { text: string; data: Record<string, unknown> }) => {
    const at = preview.text.lastIndexOf(`${name} with `);
    const told = at < 0 ? '' : preview.text.slice(at);
    const fromText = (k: string) => {
      if (!told || k === 'folder' || k === 'message') return undefined;
      if (k === 'confirm') return /confirm "([^"]+)"/.exec(told)?.[1];
      const given = [...told.matchAll(new RegExp(`\\b${k.replace(/[^\w]/g, '\\$&')} ("(?:[^"\\\\]|\\\\.)*"|-?\\d+|\\[[^\\]\\n]*\\]|true|false)`, 'g'))].at(-1);
      try { return given ? JSON.parse(given[1]!) : undefined; } catch { return undefined; }
    };
    const values: Record<string, unknown> = {};
    for (const k of new Set(['confirm', ...((await started).tools.get(name) ?? [])])) {
      if (Object.hasOwn(first, k)) continue;
      const v = Object.hasOwn(preview.data, k) ? preview.data[k] : fromText(k);
      if (v !== undefined) values[k] = v;
    }
    if (values['name'] !== undefined && values['name'] !== skill) throw new Error(`the preview is for ${JSON.stringify(values['name'])}, not ${skill}: not confirmed`);
    return typeof values['confirm'] === 'string' ? { ...first, ...values } : undefined;
  };
  // The command line, as this developer's machine: the same settings as their server, in their folder. Piped (the
  // assistant's own call): its words shown behind the gutter, the first line orange when it fails. In the person's own
  // terminal (their turn): the pane's, so its question and their answer show as they are.
  const cli = o.cli ?? cliCommand(o.command);
  const runCli = (args: string[], inTerminal: boolean) => new Promise<Reply>((done, fail) => {
    const env = serverEnv({ ...o, runId: process.env.QA_RUN_ID });
    if (inTerminal) o.terminal!.pause();
    const p = spawn(cli[0]!, [...cli.slice(1), ...args], { env, cwd: join(o.root, 'work', o.who), stdio: inTerminal ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (out += d));
    p.on('error', (e) => { if (inTerminal) o.terminal!.resume(); fail(e); });
    p.on('close', (code) => {
      if (inTerminal) { o.terminal!.resume(); done({ text: '', shown: true }); return; }
      done({ text: out.trimEnd(), alert: code === 0 ? [] : [0] });
    });
  });
  return {
    logs: true,
    runsCli: true,
    async call(who, c) {
      if (who !== o.who) throw new Error(`this server acts as ${o.who}, not ${who}`);
      if (c.op === 'install') return runCli(['install', c.name], false);
      if (c.op === 'update') return runCli(['update'], false);
      if (c.op === 'accept') return runCli(['update', c.name, '--accept'], !!o.terminal);
      const name = toolName(s, c.op);
      switch (c.op) {
        case 'search': return tool(name, { query: c.query });
        case 'read': return tool(name, { name: c.name });
        case 'versions': return tool(name, { name: c.name });
        case 'diff': return tool(name, { name: c.name, from: c.from, to: c.to });
        case 'publish': {
          const args = { folder: join(o.root, 'work', o.who, 'skills', c.folder), ...(c.message ? { message: c.message } : {}) };
          const first = await tool(name, args);
          const second = first.isError ? undefined : await secondCall(name, c.name, args, first);
          // the confirm's line shows what it confirms: the preview's name, version and flags, as given
          const shown = ['name', 'version', 'flags'].flatMap((k) => (second && Object.hasOwn(second, k) ? [`${k} ${JSON.stringify(second[k])}`] : []));
          return { text: first.text, alert: first.alert, ...(second ? { next: { tool: name, args: `${c.name} (confirm${shown.length ? `: ${shown.join(', ')}` : ''})`, yes: 'publishing', call: () => tool(name, second) } } : {}) };
        }
      }
    },
    close() {
      stopped = true;
      if (child && child.exitCode === null && child.signalCode === null) { child.stdin?.end(); child.kill(); }
    },
    pid: () => child?.pid,
  };
}

const argsOf = (c: Op) => (c.op === 'search' ? JSON.stringify(c.query) : c.op === 'diff' ? `${c.name} v${c.from} → v${c.to}` : c.op === 'update' ? '' : c.name);

/** A line cut at spaces into pieces of at most `width` characters (a longer word is cut where it must). */
export function wrap(line: string, width: number): string[] {
  if (!(width > 0) || line.length <= width) return [line];
  const pieces: string[] = [];
  let rest = line;
  while (rest.length > width) {
    const cut = rest.lastIndexOf(' ', width);
    const at = cut > 0 ? cut : width;
    pieces.push(rest.slice(0, at));
    rest = rest.slice(cut > 0 ? at + 1 : at);
  }
  return [...pieces, rest];
}

/** Text for the pane from a catalog (a server's especially): every control character but the line break becomes a
 *  space, so no escape sequence reaches the terminal. */
export const printable = (text: string) => text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ');

/** The product's words as the pane's lines, each behind the gutter; at `pane` columns a line goes on under the gutter,
 *  whole words (0: no wrapping). No line is wider than the pane. */
export function shown(text: string, pane: number, alert: number[] = []): string[] {
  const width = pane ? pane - GUTTER.length : 0;
  return printable(text).split('\n').flatMap((l, i) => wrap(l, width).map((w) => (alert.includes(i) ? paint(ORANGE, `${GUTTER}${w}`) : `${paint(DIM, GUTTER.trimEnd())} ${w}`)));
}

function show(st: Stage, text: string, alert: number[] = []): void {
  const pane = typeof st.width === 'function' ? st.width() : st.width ?? 0;
  st.out(shown(text, pane, alert).join('\n') + '\n');
}

function log(st: Stage, tool: string, target: string, result: string): void {
  const file = st.logFile ?? join(st.demoDir, 'activity.log');   // added to, never made: the director makes its folder
  appendFileSync(file, logLine({ at: (st.now ?? (() => new Date()))(), who: st.who, tool, target, result }, st.scenes.developers.map((d) => d.id)) + '\n');
}

async function call(st: Stage, c: Call): Promise<void> {
  if ('planned' in c) {
    const tool = toolName(st.surface, c.planned);
    // a part that isn't built: no tool call happened, so the log has no line for it
    st.out(paint(DIM, `  ● ${tool}: ${c.why}`) + '\n');
    return;
  }
  // A command-line op runs only on the catalog's server; on the core it's planned, in the same words (and, as a planned
  // part, no tool call: no log line).
  if (CLI_OPS.includes(c.op) && !st.backend.runsCli) {
    st.out(paint(DIM, `  ● ${toolName(st.surface, c.op)}: ${CLI_PLANNED[c.op]}`) + '\n');
    return;
  }
  // Each call as it's made, then its reply; a reply may lead to one more call (publish's confirm), shown the same way.
  // The person's own turn: they typed the command at the prompt, and it runs in their terminal (no call line).
  if (c.op === 'accept') {
    const reply = await st.backend.call(st.who, c);
    if (!reply.shown) show(st, reply.text, reply.alert);
    return;
  }
  // The command line's other ops show as the command they run; the rest as the tool's name.
  let tool = CLI_OPS.includes(c.op) ? `${st.surface.cli} ${c.op}` : toolName(st.surface, c.op), args = argsOf(c), run = () => st.backend.call(st.who, c);
  for (;;) {
    st.out(paint(GREEN, `● ${tool}${args ? `  ${printable(args)}` : ''}`) + '\n');
    let reply: Reply;
    try {
      reply = await run();
    } catch (e) {
      // an unexpected error isn't the catalog's answer: no log line, as with the server; the pane says it
      throw e;
    }
    show(st, reply.text, reply.alert);
    if (reply.log) log(st, tool, reply.log.target, reply.log.result);
    if (!reply.next) return;
    // A real assistant waits here for the person's yes (the permission prompt): the stand-in's words, dimmed.
    st.out(paint(DIM, `  (${st.who} says yes to ${reply.next.yes})`) + '\n');
    ({ tool, args, call: run } = reply.next);
  }
}

/** One typed line: its calls in order, then a turns.jsonl line. ok is false only on an unexpected error (not a refusal). */
export async function answer(st: Stage, say: string): Promise<Turn> {
  const found = findAsk(st.scenes, st.who, say);
  let ok = true;
  if (!found) st.out(paint(DIM, "(this stand-in only knows the demo's steps)") + '\n');
  else {
    for (const c of found.ask.calls) {
      if (st.pace) await new Promise((r) => setTimeout(r, st.pace));
      try {
        await call(st, c);
      } catch (e) {
        ok = false;
        // the stand-in's own words, never behind the gutter the catalog's have: orange, every line, printable
        const lines = printable(`${STAND_IN_ERROR}${(e as Error).message}`).split('\n');
        st.out(lines.map((l, i) => paint(ORANGE, `${i ? '  ' : ''}${l}`)).join('\n') + '\n');
        break;
      }
    }
  }
  const turn: Turn = { who: st.who, say: say.trim(), step: found?.step.id ?? null, ok, at: (st.now ?? (() => new Date()))().toISOString() };
  appendFileSync(join(st.demoDir, 'turns.jsonl'), JSON.stringify(turn) + '\n');
  return turn;
}

const refuse = (line: string) => { process.stderr.write(`${line}\n`); return 3; };

async function main(): Promise<number> {
  let values: { as?: string; scenes?: string };
  try {
    ({ values } = parseArgs({ options: { as: { type: 'string' }, scenes: { type: 'string' } } }));
  } catch (e) {
    return refuse((e as Error).message);
  }
  const who = values.as;
  if (!who) return refuse('usage: assistant.ts --as <developer> [--scenes <file>]');
  const file = values.scenes ?? (process.env.DEMO_SCENES || SCENES_FILE);
  let scenes: Scenes;
  try {
    scenes = loadScenes(file);
  } catch (e) {
    if (e instanceof ScenesError) return refuse(e.message);
    throw e;
  }
  if (!scenes.developers.some((d) => d.id === who)) return refuse(`${who} is not a developer in ${file}`);
  const url = process.env.SKILLS_CATALOG, root = process.env.QA_SANDBOX;
  if (!url || !root) return refuse('needs SKILLS_CATALOG and QA_SANDBOX, which the demo sets (npm run demo)');
  let server: string[] | undefined;
  try {
    if (process.env.DEMO_MCP) server = serverCommand(process.env.DEMO_MCP);
  } catch (e) {
    return refuse(`DEMO_MCP: ${(e as Error).message}`);
  }

  // The SQLite module warns that it is experimental: not in the pane. Other warnings still show.
  process.removeAllListeners('warning');
  process.on('warning', (w) => { if (w.name !== 'ExperimentalWarning') process.stderr.write(`${w.name}: ${w.message}\n`); });
  const { openCatalog } = await import('../../../core/src/open.ts');
  const surface = Surface.load();
  const stage: Omit<Stage, 'backend'> = {
    who, scenes, surface,
    out: (s) => { process.stdout.write(s); },
    width: () => process.stdout.columns || 0,   // asked each time: the pane may be resized after this starts
    demoDir: join(root, 'demo'),
    ...(process.env.SKILLS_ACTIVITY_LOG ? { logFile: process.env.SKILLS_ACTIVITY_LOG } : {}),
    pace: process.env.DEMO_PACE === '0' ? 0 : 300,
  };
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
  // The pane's terminal, lent to the command line for the person's own turn: the stand-in stops reading it and hands it
  // over in its ordinary mode (the command line sets its own), then takes it back.
  const tty = process.stdin.isTTY ? process.stdin : undefined;
  const terminal: Terminal | undefined = tty && { pause: () => { rl.pause(); tty.setRawMode(false); }, resume: () => { tty.setRawMode(true); rl.resume(); } };
  const hint = () => { process.stdout.write(`\n${paint(DIM, '(to stop the demo, press q in the Steps pane)')}\n`); rl.prompt(); };
  rl.on('SIGINT', hint);
  process.on('SIGINT', hint);
  process.stdout.write(paint(DIM, `${who}'s assistant: a stand-in, no model; the catalog is real${server ? ', over its MCP server' : ''}`) + '\n');
  rl.prompt();
  // The catalog opens (or its server starts) at the first ask, not at start: both panes start at once, and two processes
  // opening a new catalog together can fail ("database is locked"); the demo's asks come one at a time. A failed open
  // is each call's error. The server stops with the stand-in, however it ends.
  let catalog: Promise<Catalog> | undefined, backend: Backend | undefined;
  process.on('exit', () => backend?.close?.());
  for (const [sig, code] of [['SIGTERM', 143], ['SIGHUP', 129]] as const) process.on(sig, () => { backend?.close?.(); process.exit(code); });
  try {
    for await (const line of rl) {
      if (line.trim()) {
        if (server) backend ??= mcpBackend({ command: server, root, who, catalog: url, activityLog: process.env.SKILLS_ACTIVITY_LOG || join(root, 'demo', 'activity.log'), surface, ...(terminal ? { terminal } : {}) });
        else {
          catalog ??= openCatalog(url, { identity: actAs(who) });
          await catalog.catch(() => undefined);
          backend ??= coreBackend({ catalog, surface, skillsDir: join(root, 'work', who, 'skills') });
        }
        await answer({ ...stage, backend }, line);
      }
      rl.prompt();
    }
  } finally {
    backend?.close?.();
    (await catalog?.catch(() => undefined))?.close();
  }
  return 0;
}

if (import.meta.main) process.exitCode = await main();
