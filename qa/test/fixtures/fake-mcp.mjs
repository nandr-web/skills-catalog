#!/usr/bin/env node
// A stand-in MCP server for the pre-flight tests: answers initialize and lists the tools named in FAKE_MCP_TOOLS.
import { createInterface } from 'node:readline';

const tools = JSON.parse(process.env.FAKE_MCP_TOOLS ?? '[]').map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' }, instructions: 'fake' } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
  else send({ id: m.id, error: { code: -32601, message: 'no' } });
});
