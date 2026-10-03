// The MCP server's own times (review P15.4), for `npm run perf`: the QA plan measures search and read "through the MCP
// server", so this starts the client's server as an assistant does (a process, JSON-RPC over stdio) on the catalog the
// perf run built, and times: starting it until `initialize` is answered, then search, read and install, each a
// tools/call. The server is the client's (client/src/cli.ts), so it needs client/ installed; without it the pass is
// skipped, saying so.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { Words } from '../src/words-file.ts';

const CLIENT = join(import.meta.dirname, '..', '..', 'client');
const CLI = join(CLIENT, 'src', 'cli.ts');

/** Why the pass can't run here, or undefined. */
export function mcpSkipReason(): string | undefined {
  if (!existsSync(CLI) || !existsSync(join(CLIENT, 'node_modules'))) return 'the MCP server pass needs client/ installed (cd ../client && npm ci --ignore-scripts)';
  return undefined;
}

type Rpc = { call: (method: string, params?: unknown) => Promise<any>; close: () => Promise<void> };

function start(catalogDir: string, place: string): { rpc: Rpc; ready: Promise<void> } {
  mkdirSync(join(place, 'home'), { recursive: true });
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', CLI, 'mcp'], {
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: join(place, 'home'), SKILLS_HOME: join(place, 'skills-home'), SKILLS_CATALOG: pathToFileURL(catalogDir).href },
    cwd: place,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map<number, (m: any) => void>();
  let buf = '', next = 1, err = '';
  child.stderr.on('data', (b) => (err += b));
  child.stdout.on('data', (b) => {
    buf += b;
    for (let i; (i = buf.indexOf('\n')) >= 0; ) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
      waiting.delete(m.id);
    }
  });
  const exited = new Promise<void>((ok) => child.on('close', () => ok()));
  const rpc: Rpc = {
    call: (method, params) =>
      new Promise((ok, fail) => {
        const id = next++;
        waiting.set(id, (m) => (m.error ? fail(new Error(`${method}: ${JSON.stringify(m.error)} ${err}`)) : ok(m.result)));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      }),
    close: async () => {
      child.stdin.end();
      await exited;
    },
  };
  const ready = rpc.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'perf', version: '0' } }).then(() => undefined);
  return { rpc, ready };
}

async function timed(times: number[], fn: () => Promise<unknown>): Promise<void> {
  const t = performance.now();
  await fn();
  times.push(performance.now() - t);
}

/** Each measure's times in ms: start (spawn → initialize answered, `starts` times), search, read, install. */
export async function mcpTimes(o: { catalogDir: string; place: string; names: string[]; terms: string[]; calls: number; starts?: number; installs?: number }): Promise<Record<'start' | 'search' | 'read' | 'install', number[]>> {
  const T = Words.load().names as Record<string, string>;
  const out = { start: [] as number[], search: [] as number[], read: [] as number[], install: [] as number[] };
  for (let i = 0; i < (o.starts ?? 5); i++) {
    const s = start(o.catalogDir, join(o.place, `start-${i}`));
    await timed(out.start, () => s.ready);
    await s.rpc.close();
  }
  const s = start(o.catalogDir, join(o.place, 'calls'));
  await s.ready;
  const tool = async (name: string, args: unknown) => {
    const r = await s.rpc.call('tools/call', { name, arguments: args });
    if (r.isError) throw new Error(`${name} ${JSON.stringify(args)}: ${r.content?.[0]?.text}`);
  };
  try {
    for (let i = 0; i < o.calls; i++) await timed(out.search, () => tool(T['search']!, { query: o.terms[i % o.terms.length] }));
    for (let i = 0; i < o.calls; i++) await timed(out.read, () => tool(T['get']!, { name: o.names[(i * 37) % o.names.length] }));
    const installs = Math.min(o.installs ?? 50, o.names.length);
    for (let i = 0; i < installs; i++) await timed(out.install, () => tool(T['install']!, { name: o.names[(i * 53) % o.names.length] }));
  } finally {
    await s.rpc.close();
  }
  return out;
}
