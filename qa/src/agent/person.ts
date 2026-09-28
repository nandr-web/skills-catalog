#!/usr/bin/env node
// The stand-in person (brief §2.2): a QA MCP server over stdio with one tool, `approve`, used as Claude Code's
// `--permission-prompt-tool`. It approves only the tools the scenario agrees to (QA_PERSON_AGREES, a JSON list of tool
// names), refuses the rest, and records every request (QA_PERSON_LOG, one JSON line each). No dependencies: newline-
// delimited JSON-RPC 2.0, the MCP stdio transport.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const agrees: string[] = JSON.parse(process.env.QA_PERSON_AGREES ?? '[]');
const log = process.env.QA_PERSON_LOG;
const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

const TOOL = {
  name: 'approve',
  description: 'Answers a permission prompt on behalf of the person running this test.',
  inputSchema: { type: 'object', properties: { tool_name: { type: 'string' }, input: { type: 'object' }, tool_use_id: { type: 'string' } }, required: ['tool_name', 'input'] },
};

function decide(args: { tool_name?: string; input?: Record<string, unknown> }) {
  const tool = String(args.tool_name ?? '');
  const allow = agrees.includes(tool);
  if (log) appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), tool_name: tool, input: args.input ?? {}, decision: allow ? 'allow' : 'deny' }) + '\n');
  return allow
    ? { behavior: 'allow', updatedInput: args.input ?? {} }
    : { behavior: 'deny', message: `The person running this test didn't agree to ${tool} in this scenario.` };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let m: any;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;   // a notification
  switch (m.method) {
    case 'initialize':
      return send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'qa-person', version: '0.1.0' } } });
    case 'ping':
      return send({ id: m.id, result: {} });
    case 'tools/list':
      return send({ id: m.id, result: { tools: [TOOL] } });
    case 'tools/call':
      if (m.params?.name !== 'approve') return send({ id: m.id, error: { code: -32602, message: `no tool ${m.params?.name}` } });
      return send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(decide(m.params.arguments ?? {})) }] } });
    default:
      return send({ id: m.id, error: { code: -32601, message: `no method ${m.method}` } });
  }
});
