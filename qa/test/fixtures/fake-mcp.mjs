#!/usr/bin/env node
// A stand-in MCP server for the tests: answers initialize, lists the tools named in FAKE_MCP_TOOLS, and answers any tool
// call with an empty result. With QA_FAKE_MCP_ENV_OUT it records its whole environment there first.
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.QA_FAKE_MCP_ENV_OUT) writeFileSync(process.env.QA_FAKE_MCP_ENV_OUT, JSON.stringify(process.env));
const tools = JSON.parse(process.env.FAKE_MCP_TOOLS ?? '[]').map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' }, instructions: 'fake' } });
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools } });
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '{"results":[],"match":"none"}' }] } });
  else send({ id: m.id, error: { code: -32601, message: 'no' } });
});
