// A golden row for behaviour the product doesn't have yet carries `pending: "<what it waits for>"`, and the tests that
// read it run it as skipped, never as passed. This lists every such row across the golden files, so none is forgotten:
// the commit that builds a behaviour removes its markers, and its lines here.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const golden = fileURLToPath(new URL('../golden/', import.meta.url));

// Every object with a `pending` key, as "<file>: <path> (<id>)", and what each waits for.
function pendingRows(node: unknown, at: string, out: { row: string; waits: unknown }[]): { row: string; waits: unknown }[] {
  if (Array.isArray(node)) node.forEach((x, i) => pendingRows(x, `${at}[${i}]`, out));
  else if (node !== null && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if ('pending' in o) out.push({ row: typeof o['id'] === 'string' ? `${at} (${o['id']})` : at, waits: o['pending'] });
    for (const [k, v] of Object.entries(o)) if (k !== 'pending') pendingRows(v, `${at}.${k}`, out);
  }
  return out;
}

const rows = readdirSync(golden)
  .filter((f) => /\.ya?ml$/.test(f))
  .sort()
  .flatMap((f) => pendingRows(parse(readFileSync(golden + f, 'utf8')), f.replace(/\.ya?ml$/, ''), []));

describe('pending golden rows', () => {
  it('each says, in words, what it waits for', () => {
    for (const r of rows) expect(typeof r.waits === 'string' && r.waits.trim().length > 0, r.row).toBe(true);
  });

  it('are exactly these (a built behaviour removes its rows here and its markers in the goldens)', () => {
    expect(rows.map((r) => r.row)).toEqual(PENDING);
  });
});

const PENDING: string[] = [
  // Held-update examples that need the installer to check for commands run at load, and the rules reviewer's findings.
  'policy.cases[40]',
  'policy.cases[46]',
  'policy.accept_cases.keeps_policy.cases[2]',
  // The rules reviewer: prompt_injection's six rules and context_cost.
  'skills.rules_review',
  // One filter tag over 32 characters: item_too_long.
  'skills.search_filters[1]',
  // The front matter counted first in the read budget.
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 18].map((i) => `skills.reads.cases[${i}]`),
  // The preview as its own tool, and a publish that requires every input.
  'skills.publish_steps.cases[30] (preview-invalid-manifest)',
  'skills.publish_steps.cases[31] (preview-secret)',
  'skills.publish_steps.cases[32] (preview-nothing-changes)',
  'skills.publish_steps.request_checks[11] (publish-folder-only)',
  'skills.publish_steps.request_checks[12] (preview-takes-no-confirm)',
];
