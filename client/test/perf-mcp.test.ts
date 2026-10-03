// `npm run perf`'s pass through the MCP server (core/scripts/perf-mcp.ts, review P15.4) kept working: on a tiny catalog
// it starts the client's server, gets initialize answered, and times search, read and install as tool calls (a call
// that comes back as an error fails it, so a timing never hides a refusal).
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openCatalog, actAs } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { mcpSkipReason, mcpTimes } from '../../core/scripts/perf-mcp.ts';
import { PROCESS_TEST_MS } from './server.ts';

const skill = (name: string) => ({
  name,
  files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(`---\nname: ${name}\ndescription: Draft ${name.replace(/-/g, ' ')} quickly.\n---\nBody.\n`).toString('base64') }],
});

describe("perf's MCP server pass", () => {
  it(
    'times the start, search, read and install through the server on a small catalog',
    async () => {
      expect(mcpSkipReason()).toBeUndefined();
      const dir = sandbox();
      const catalogDir = join(dir, 'catalog');
      const c = await openCatalog(pathToFileURL(catalogDir).href);
      const names = ['release-note-draft', 'sql-migration-helper', 'pdf-form-filler']; // (release-notes is a reserved name: a built-in command)
      for (const n of names) await c.publish(skill(n), actAs('ana'));
      c.close();
      const t = await mcpTimes({ catalogDir, place: join(dir, 'mcp'), names, terms: ['release', 'migrations'], calls: 3, starts: 2, installs: 2 });
      expect([t.start.length, t.search.length, t.read.length, t.install.length]).toEqual([2, 3, 3, 2]);
      for (const ms of [...t.start, ...t.search, ...t.read, ...t.install]) expect(ms).toBeGreaterThan(0);
    },
    PROCESS_TEST_MS,
  );
});
