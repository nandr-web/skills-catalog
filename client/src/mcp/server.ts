// The MCP server over stdio (contract §1, §3): newline-delimited JSON-RPC 2.0 with the few methods a tools-only server
// needs (initialize, ping, tools/list, tools/call). It's written here rather than taken from the MCP SDK, whose 17
// runtime dependencies are for HTTP transports this server never uses. The tools are the registry's (Surface.toolDefs),
// every word an assistant reads is the vendored surface's, and every answer is the core's.
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { actAs, CatalogError, openCatalog, renderError, Surface, toCatalogError, type Catalog } from '@skills-catalog/core';
import { appendActivity } from '../activity.ts';
import type { Settings } from '../settings.ts';
import { actingAs, RUNS, type Done } from './tools.ts';

/** The protocol versions this server speaks, newest first. A tools-only server with text results reads the same in each. */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

// JSON-RPC 2.0's error codes.
const PARSE_ERROR = -32700, INVALID_REQUEST = -32600, METHOD_NOT_FOUND = -32601, INVALID_PARAMS = -32602, INTERNAL = -32603;

class RpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Id = string | number | null;
type Message = Record<string, unknown>;
const isObject = (x: unknown): x is Message => typeof x === 'object' && x !== null && !Array.isArray(x);
const reply = (id: Id, result: unknown) => ({ jsonrpc: '2.0', id, result });
const failure = (id: Id, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export type ServerOptions = { settings: Settings; version: string; surface?: Surface; now?: () => Date };

export function createMcpServer(o: ServerOptions) {
  const surface = o.surface ?? Surface.load();
  const now = o.now ?? (() => new Date());
  const { settings } = o;
  const tools = new Map(
    surface
      .toolDefs()
      .filter((d) => RUNS[d.op])
      .map((d) => [d.name, d]),
  );

  // Opened on the first tool call, so a catalog that can't be opened is an error the assistant reads, not a server
  // that won't start. A failed open is tried again on the next call.
  let opened: Promise<Catalog> | undefined;
  const catalog = () =>
    (opened ??= openCatalog(settings.catalog, { identity: actAs(settings.developer) }).catch((e) => {
      opened = undefined;
      throw e;
    }));

  async function callTool(params: unknown) {
    if (!isObject(params) || typeof params['name'] !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs params.name, a tool name');
    const def = tools.get(params['name']);
    if (!def) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params['name']}`);
    let done: Done;
    let isError = false;
    try {
      if (settings.developerInvalid) throw new CatalogError('invalid_request', { field: 'as', why: 'not_a_developer_name' });
      done = await RUNS[def.op]!(await catalog(), surface, params['arguments']);
    } catch (e) {
      // A contract error in words; anything else is a bug in skills-catalog: its traceback goes to a log file in
      // SKILLS_HOME, never to the assistant (contract §9).
      const err = toCatalogError(e, settings.home, now());
      done = { text: renderError(surface, err), target: '-', result: err.code };
      isError = true;
    }
    appendActivity(settings.activityLog, { at: now(), who: settings.developer, tool: def.name, target: done.target, result: done.result });
    const text = settings.developer ? `${done.text}\n${actingAs(settings.developer)}` : done.text;
    return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
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
      const id = isObject(msg) && (typeof msg['id'] === 'string' || typeof msg['id'] === 'number') ? msg['id'] : null;
      return failure(id, INVALID_REQUEST, 'Invalid Request: one JSON-RPC 2.0 message per line (batches are not supported)');
    }
    if (!('id' in msg)) return undefined; // a notification (initialized, cancelled, …): nothing to answer
    const id = msg['id'];
    if (id !== null && typeof id !== 'string' && typeof id !== 'number') return failure(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
    try {
      return reply(id, await dispatch(msg['method'], msg['params']));
    } catch (e) {
      if (e instanceof RpcError) return failure(id, e.code, e.message);
      return failure(id, INTERNAL, 'Internal error');
    }
  }

  function close(): void {
    opened?.then((c) => c.close()).catch(() => {});
  }

  return { handle, close };
}

/** Serves until the input closes, then answers what's in flight, closes the catalog and returns. stdout carries only
 *  JSON-RPC messages, one per line. */
export async function serveStdio(o: ServerOptions, input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
  const server = createMcpServer(o);
  const send = (m: object) => output.write(JSON.stringify(m) + '\n');
  const inFlight = new Set<Promise<void>>();
  for await (const line of createInterface({ input, crlfDelay: Infinity })) {
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
