// The MCP server under test, as a real process over stdio (one process per client, as an assistant runs it). Its whole
// environment is given here, nothing inherited: SKILLS_HOME, the catalog and HOME are all inside a folder this test run
// made, and the core's fail-safe refuses any other place before the server starts (contract §8).
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { refuseRealPlaces, sandbox } from '@skills-catalog/core/testing';
import { onTestFinished } from 'vitest';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** The budget for a test that starts the server as a process: on a busy machine a reply can take several seconds (it
 *  is waited for up to 20 s, below), past vitest's default 5 s. Set per file (vi.setConfig) in the files that start a
 *  server, so a plain unit test keeps the default and still fails fast if it hangs. */
export const PROCESS_TEST_MS = 30_000;

/** A place for one test: the server's SKILLS_HOME, the local catalog's folder and an OS home, all in one sandbox. */
export type Place = { dir: string; home: string; catalogDir: string; catalogUrl: string; osHome: string };

export function place(): Place {
  const dir = sandbox();
  const catalogDir = join(dir, 'catalog');
  return { dir, home: join(dir, 'skills-home'), catalogDir, catalogUrl: pathToFileURL(catalogDir).href, osHome: join(dir, 'os-home') };
}

export type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };

export interface Server {
  /** A request; resolves with the whole response ({result} or {error}). */
  send(method: string, params?: unknown): Promise<any>;
  /** A notification: no id, so no reply. */
  notify(method: string, params?: unknown): void;
  /** One raw line, as is (for malformed input); resolves with the reply to id null (a line the server couldn't read). */
  raw(line: string): Promise<any>;
  /** One whole message, ids and all (a recorded frame); resolves with its reply, or undefined for a notification. */
  frame(message: Record<string, unknown>): Promise<any>;
  /** Text with no newline after it (part of a line); resolves with the next reply to id null. */
  partial(text: string): Promise<any>;
  /** Text as is, expecting no reply (the end of a line already refused). */
  write(text: string): void;
  initialize(protocolVersion?: string): Promise<any>;
  /** tools/call; resolves with the result (throws on a JSON-RPC error). */
  call(name: string, args?: unknown): Promise<ToolResult>;
  /** The text of a tools/call result. */
  text(name: string, args?: unknown): Promise<string>;
  /** Every stdout line so far. */
  readonly lines: string[];
  readonly stderr: () => string;
  /** Closes stdin and waits for the exit code. */
  close(): Promise<number | null>;
}

export function startServer(p: Place, env: Record<string, string> = {}): Server {
  const full: Record<string, string> = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: p.osHome,
    SKILLS_HOME: p.home,
    SKILLS_CATALOG: p.catalogUrl,
    // Not UTC, so a local time anywhere (the activity log's clock) differs from UTC even on a machine set to UTC.
    TZ: 'Asia/Kolkata',
    ...env,
  };
  for (const k of ['HOME', 'SKILLS_HOME', 'SKILLS_ACTIVITY_LOG', 'SKILLS_ASSISTANT_HOME'] as const) if (full[k] !== undefined) refuseRealPlaces(full[k]);
  if (full['SKILLS_CATALOG']!.startsWith('file:')) refuseRealPlaces(fileURLToPath(full['SKILLS_CATALOG']!));

  const child = spawn(process.execPath, [CLI, 'mcp'], { env: full, cwd: p.dir, stdio: ['pipe', 'pipe', 'pipe'] });
  // Never left behind: however the test ends (a timeout, a failure, a server stuck in a system call that can't see its
  // input close), the server it started is killed once the test is over.
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const lines: string[] = [];
  const waiting = new Map<number | string | null, (m: any) => void>();
  let buf = '', err = '', next = 1;
  const exited = new Promise<number | null>((ok) => child.on('close', (code) => ok(code)));
  child.stderr.on('data', (b) => (err += b));
  child.stdout.on('data', (b) => {
    buf += b;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      lines.push(line);
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const w = waiting.get(m?.id ?? null);
      if (w) {
        waiting.delete(m.id ?? null);
        w(m);
      }
    }
  });
  const write = (o: unknown) => child.stdin.write(JSON.stringify(o) + '\n');
  const reply = (id: number | string | null) =>
    new Promise<any>((ok, no) => {
      const t = setTimeout(() => no(new Error(`no reply to ${String(id)} in 20 s; stderr: ${err.slice(-500)}`)), 20_000);
      waiting.set(id, (m) => (clearTimeout(t), ok(m)));
    });
  const s: Server = {
    send(method, params) {
      const id = next++;
      const r = reply(id);
      write({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
      return r;
    },
    notify(method, params) {
      write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
    },
    raw(line) {
      const r = reply(null);
      child.stdin.write(line + '\n');
      return r;
    },
    frame(message) {
      const r = 'id' in message ? reply(message['id'] as number | string | null) : Promise.resolve(undefined);
      write(message);
      return r;
    },
    partial(text) {
      const r = reply(null);
      child.stdin.write(text);
      return r;
    },
    write(text) {
      child.stdin.write(text);
    },
    async initialize(protocolVersion = '2025-06-18') {
      const r = await s.send('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '0' } });
      s.notify('notifications/initialized');
      return r;
    },
    async call(name, args) {
      const r = await s.send('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) });
      if (r.error) throw new Error(`tools/call ${name}: ${r.error.code} ${r.error.message}`);
      return r.result;
    },
    async text(name, args) {
      const r = await s.call(name, args);
      return r.content.map((c) => c.text).join('\n');
    },
    lines,
    stderr: () => err,
    async close() {
      child.stdin.end();
      return exited;
    },
  };
  return s;
}
