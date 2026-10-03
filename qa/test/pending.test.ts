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
  // A markdown file that isn't UTF-8 flagged runs_at_load at line 1: the tests read versions as text.
  'histories.histories.gate_bytes',
  // The permissive-mode check reading CLAUDE_CONFIG_DIR's settings too, and the folder setup records.
  'policy.permissive_settings[60]',
  'policy.permissive_settings[61]',
  'policy.permissive_settings[62]',
  'policy.permissive_settings[63]',
  'policy.permissive_settings[64]',
  'policy.permissive_settings[65]',
  'policy.permissive_settings[66]',
  'policy.permissive_settings[67]',
  'policy.permissive_settings[68]',
  'policy.permissive_settings[69]',
  'policy.permissive_settings[70]',
  'policy.permissive_settings[71]',
  'policy.permissive_settings[72]',
  'policy.permissive_settings[73]',
  'policy.permissive_settings[74]',
  'policy.permissive_settings[75]',
  // Guided setup, teardown and the session-start hook, and the rows that wait for their words.
  'setup.setup',
  'setup.setup.cases[6] (link-claude-json)',
  'setup.setup.cases[8] (link-settings-json)',
  'setup.setup.cases[20] (dry-run)',
  'setup.setup.cases[24] (teardown-entry-edited)',
  'setup.setup.cases[26] (teardown-damaged-lock-config)',
  'setup.setup.cases[27] (teardown-damaged-record)',
  'setup.setup.cases[28] (teardown-record-elsewhere)',
  'setup.setup.cases[29] (person-only-rules)',
  'setup.setup.cases[31] (read-rule-not-person-only)',
  'setup.setup.cases[32] (read-rules-switch)',
  'setup.setup.cases[33] (permissive-and-unknown)',
  'setup.setup.cases[38] (inside-claude-code)',
  'setup.setup.cases[41] (managed-policy)',
  'setup.setup.cases[43] (hook-entry-gone)',
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
