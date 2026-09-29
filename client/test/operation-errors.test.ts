// skills.yaml operation_errors through the assistant's tools and the CLI, for the operations that have them: each gives
// the row's error in the words file's words, as the core raises it (the core's own test runs each row as every face).
import { Buffer } from 'node:buffer';
import { OPERATIONS, Words, actAs, openLocalCatalog, renderError, type Catalog, type CatalogError } from '@skills-catalog/core';
import { historyVersion, loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { S as CLI_WORDS, cli } from './cli-io.ts';
import { PROCESS_TEST_MS, place, startServer, type Place, type Server } from './server.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS }); // one server process for the file (see PROCESS_TEST_MS)

const S = Words.load();
const histories = loadGolden('histories.yaml');
const cases = (loadGolden('skills.yaml').operation_errors.cases as any[]).filter((r) => !r.acting && OPERATIONS[r.call]!.faces.some((f) => f !== 'web'));
const NAME = 'pr-review-checklist';

// A row's input as the CLI takes it (contract §1): the name positional, the versions named.
const ARGV: Record<string, (a: any) => string[]> = {
  list_shared_skill_versions: (a) => ['versions', a.name],
  diff_shared_skill_versions: (a) => ['diff', a.name, '--from', String(a.from), '--to', String(a.to)],
};

// One catalog and one server for every row (they change nothing); both start inside the test that uses them.
async function started(): Promise<{ p: Place; c: Catalog; s: Server }> {
  const p = place();
  const c = await openLocalCatalog(p.catalogDir);
  for (const v of ['prc.v1', 'prc.v2', 'prc.v3']) {
    const files = historyVersion(histories.versions[v]).map((f) => ({ path: f.path, mode: f.mode, content_base64: Buffer.from(f.bytes).toString('base64') }));
    await c.publish({ name: NAME, files }, actAs('dev1'));
  }
  const s = startServer(p);
  await s.initialize();
  return { p, c, s };
}

async function coreError(c: Catalog, row: any): Promise<CatalogError> {
  const run = OPERATIONS[row.call]!.run;
  try {
    await (c as unknown as Record<string, (a: unknown) => Promise<unknown>>)[run]!(row.args);
  } catch (e) {
    return e as CatalogError;
  }
  throw new Error(`${row.id}: the core gave no error`);
}

describe('each operation\'s errors no other row reaches, through its tool and its command', () => {
  it('covers the rows with a tool or a command', () => {
    expect(cases.map((r) => r.call).sort()).toEqual([...Array(3).fill('diff_shared_skill_versions'), ...Array(3).fill('list_shared_skill_versions')]);
    for (const r of cases) expect([r.id, Object.keys(ARGV).includes(r.call)]).toEqual([r.id, true]);
  });

  it('each row: the tool and the command give the core\'s error', async () => {
    const { p, c, s } = await started();
    try {
      for (const row of cases) {
        const e = await coreError(c, row);
        expect([row.id, e.code]).toEqual([row.id, row.expect.error]);
        const def = OPERATIONS[row.call]!;
        if (def.faces.includes('mcp')) {
          const r = await s.call((S.names as Record<string, string>)[def.words!]!, row.args);
          expect([row.id, r.isError, r.content]).toEqual([row.id, true, [{ type: 'text', text: renderError(S, e) }]]);
        }
        if (def.faces.includes('cli')) {
          const r = await cli(p, ARGV[row.call]!(row.args));
          expect([row.id, r.code, r.out, r.err]).toEqual([row.id, 1, '', renderError(CLI_WORDS, e) + '\n']);
        }
      }
    } finally {
      c.close();
      await s.close();
    }
  });
});
