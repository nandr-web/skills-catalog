// The MCP server over stdio (contract §1, §3): newline-delimited JSON-RPC 2.0 with the few methods a tools-only server
// needs (initialize, ping, tools/list, tools/call). It's written here rather than taken from the MCP SDK, whose 17
// runtime dependencies are for HTTP transports this server never uses. The tools are the registry's (Surface.toolDefs),
// and each call is the client's face-neutral operation (operations.ts), so the MCP text is what the CLI prints.
import type { Readable, Writable } from 'node:stream';
import { Surface } from '@skills-catalog/core';
import { contextFor, perform, RUNS } from '../operations.ts';
import type { Settings } from '../settings.ts';

/** The protocol versions this server speaks, newest first. 2025-03-26 isn't offered: it requires JSON-RPC batches. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05'] as const;

/** The longest line read (a message is one line): a longer one is refused and skipped to its end, never held whole. */
export const MAX_LINE = 4 * 1024 * 1024;

// JSON-RPC 2.0's error codes.
const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL = -32603;

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Message = Record<string, unknown>;
const isObject = (x: unknown): x is Message => typeof x === 'object' && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is string | number => typeof x === 'string' || typeof x === 'number';
const reply = (id: string | number, result: unknown) => ({ jsonrpc: '2.0', id, result });
const failure = (id: string | number | null, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export type ServerOptions = { settings: Settings; version: string; surface?: Surface; now?: () => Date };

export function createMcpServer(o: ServerOptions) {
  const surface = o.surface ?? Surface.load();
  const { ctx, close } = contextFor(o.settings, surface, 'mcp', o.now);
  const tools = new Map(
    surface
      .toolDefs()
      .filter((d) => RUNS[d.op])
      .map((d) => [d.name, d]),
  );

  async function callTool(params: unknown) {
    if (!isObject(params) || typeof params['name'] !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs params.name, a tool name');
    const def = tools.get(params['name']);
    if (!def) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params['name']}`);
    const a = await perform(ctx, def.op, def.name, params['arguments']);
    return { content: [{ type: 'text', text: a.text }], ...(a.isError ? { isError: true } : {}) };
  }

  async function dispatch(method: string, params: unknown): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = isObject(params) ? params['protocolVersion'] : undefined;
        const protocolVersion = PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0];
        const instructions = surface.instructions;
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: surface.serverName, version: o.version },
          ...(instructions ? { instructions } : {}),
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: [...tools.values()].map(({ op: _op, ...t }) => t) };
      case 'tools/call':
        return callTool(params);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  /** One message in, its response out (undefined for a notification, which never gets one). */
  async function handle(msg: unknown): Promise<object | undefined> {
    if (!isObject(msg) || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') {
      return failure(isObject(msg) && isId(msg['id']) ? msg['id'] : null, INVALID_REQUEST, 'Invalid Request: one JSON-RPC 2.0 message per line (batches are not supported)');
    }
    if (!('id' in msg)) return undefined; // a notification (initialized, cancelled, …): nothing to answer
    const id = msg['id'];
    if (!isId(id)) return failure(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
    try {
      return reply(id, await dispatch(msg['method'], msg['params']));
    } catch (e) {
      if (e instanceof RpcError) return failure(id, e.code, e.message);
      return failure(id, INTERNAL, 'Internal error');
    }
  }

  return { handle, close };
}

/** The input's lines, each at most MAX_LINE characters: a longer one is reported (`tooLong`) and skipped to its end,
 *  so memory stays bounded whatever arrives. */
async function* linesOf(input: Readable, tooLong: () => void): AsyncGenerator<string> {
  input.setEncoding('utf8');
  let buf = '';
  let skipping = false;
  for await (const chunk of input as AsyncIterable<string>) {
    let start = 0;
    for (let i = chunk.indexOf('\n'); i >= 0; i = chunk.indexOf('\n', start)) {
      const part = chunk.slice(start, i);
      start = i + 1;
      if (skipping) {
        skipping = false;
        continue;
      }
      const line = buf + part;
      buf = '';
      if (line.length > MAX_LINE) tooLong();
      else yield line;
    }
    if (skipping) continue;
    buf += chunk.slice(start);
    if (buf.length > MAX_LINE) {
      tooLong();
      buf = '';
      skipping = true;
    }
  }
  if (buf && !skipping) yield buf; // a last line without its newline
}

/** Serves until the input closes, then answers what's in flight, closes the catalog and returns. stdout carries only
 *  JSON-RPC messages, one per line. */
export async function serveStdio(o: ServerOptions, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const server = createMcpServer(o);
  const send = (m: object) => output.write(JSON.stringify(m) + '\n');
  const inFlight = new Set<Promise<void>>();
  const tooLong = () => send(failure(null, INVALID_REQUEST, `Invalid Request: a line over ${MAX_LINE} characters, skipped`));
  for await (const line of linesOf(input, tooLong)) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send(failure(null, PARSE_ERROR, 'Parse error: each line must be one JSON-RPC message'));
      continue;
    }
    const p: Promise<void> = server
      .handle(msg)
      .then((r) => {
        if (r) send(r);
      })
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
  }
  await Promise.all(inFlight);
  server.close();
}
