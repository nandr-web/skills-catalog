// A minimal MCP client over stdio (newline-delimited JSON-RPC 2.0): start a server, initialize, call methods, stop.
// For the pre-flight's server self-test now, and the interface tests on the MCP face later (slice 3).
import { spawn, type ChildProcess } from 'node:child_process';

export type McpClient = { request: (method: string, params?: unknown) => Promise<any>; close: () => void; init: any };

export async function connect(command: string[], env: Record<string, string> = {}, timeoutMs = 30_000): Promise<McpClient> {
  const p: ChildProcess = spawn(command[0], command.slice(1), { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map<number, { ok: (v: any) => void; no: (e: Error) => void }>();
  let buf = '', err = '', next = 1, dead: Error | undefined;
  const fail = (e: Error) => { dead ??= e; for (const w of waiting.values()) w.no(e); waiting.clear(); };
  p.stderr!.on('data', (b) => { err = (err + b).slice(-2000); });
  p.stdout!.on('data', (b) => {
    buf += b;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m: any; try { m = JSON.parse(line); } catch { continue; }
      const w = m.id !== undefined ? waiting.get(m.id) : undefined;
      if (!w) continue;
      waiting.delete(m.id);
      if (m.error) w.no(new Error(`${m.error.code}: ${m.error.message}`)); else w.ok(m.result);
    }
  });
  p.on('exit', (code) => fail(new Error(`the server exited (${code})${err ? `: ${err.trim().split('\n').slice(-3).join(' ')}` : ''}`)));
  p.on('error', (e) => fail(e));
  const request = (method: string, params?: unknown) => new Promise<any>((ok, no) => {
    if (dead) return no(dead);
    const id = next++;
    const t = setTimeout(() => { waiting.delete(id); no(new Error(`${method}: no answer in ${timeoutMs / 1000} s`)); }, timeoutMs);
    waiting.set(id, { ok: (v) => { clearTimeout(t); ok(v); }, no: (e) => { clearTimeout(t); no(e); } });
    p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
  });
  const close = () => { try { p.stdin!.end(); p.kill(); } catch { /* gone */ } };
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'skills-catalog-qa', version: '0.1.0' } });
    p.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return { request, close, init };
  } catch (e) {
    close();
    throw e;
  }
}
