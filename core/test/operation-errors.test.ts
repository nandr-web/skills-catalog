// skills.yaml operation_errors: each operation's errors that no other golden row reaches (contract §1, §9), driven
// through the core as each face the operation has; the MCP and CLI faces are driven in the client's own test.
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/api.ts';
import type { Catalog } from '../src/catalog.ts';
import { actAs } from '../src/local/index.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { errorOf, openTest, request, snapshot } from './helpers.ts';

const skills = loadGolden('skills.yaml');
const histories = loadGolden('histories.yaml');
const rows = skills.operation_errors;
const NAME = 'pr-review-checklist';

// The row's catalog: histories.yaml's prc@v3, published as dev1.
async function prcAtV3(): Promise<{ dir: string; catalog: Catalog }> {
  const opened = await openTest();
  for (const v of ['prc.v1', 'prc.v2', 'prc.v3']) await opened.catalog.publish(request(NAME, historyVersion(histories.versions[v])), actAs('dev1'));
  return opened;
}

function checkError(e: { code: string; data: Record<string, unknown> }, expected: Record<string, unknown>): void {
  const { error, suggestions_include, ...fields } = expected;
  expect(e.code).toBe(error);
  for (const [k, v] of Object.entries(fields)) expect([k, e.data[k]]).toEqual([k, v]);
  for (const s of (suggestions_include as string[] | undefined) ?? []) expect(e.data['suggestions']).toContain(s);
}

describe('each operation\'s errors no other row reaches (skills.yaml operation_errors)', () => {
  it('the rows are run, not pending, on the catalog they name', () => {
    expect(rows.pending).toBeUndefined();
    expect(rows.catalog).toBe('histories.prc@v3');
  });

  const cases = (rows.cases as any[]).flatMap((row) => OPERATIONS[row.call]!.faces.map((face) => [row.id, face, row] as const));
  it.each(cases)('%s as the %s face: the error it pins, and storage unchanged', async (_id, face, row) => {
    const { dir, catalog } = await prcAtV3();
    const def = OPERATIONS[row.call]!;
    const before = snapshot(dir);
    const e = await errorOf(() => {
      if (def.run === 'publish') {
        const input = request(row.args.name, historyVersion(histories.versions[row.args.files]));
        return catalog.publish(input, actAs(row.acting === 'none' ? undefined : 'dev1'), face);
      }
      return (catalog as unknown as Record<string, (a: unknown, f: string) => Promise<unknown>>)[def.run]!(row.args, face);
    });
    catalog.close();
    checkError(e, row.expect);
    expect(snapshot(dir)).toBe(before);
  });
});
