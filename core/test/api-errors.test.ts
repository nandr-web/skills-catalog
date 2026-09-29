// Each operation's errors (contract §1: the codes it can raise, "proved by a test that drives its golden error rows").
// Every golden error row is driven by its own harness (golden-rules, catalog, publish-steps, installer, policy, …), which
// fails on any other code. Here each one is read, placed on its operation, and the row checked both ways: every code the
// goldens expect for an operation is in its list (or in COMMON_ERRORS), and every code in its list is expected by some
// golden row, or is named in MISSING_GOLDENS: a code the operation's code raises that no golden row reaches yet.
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/api.ts';
import { COMMON_ERRORS } from '../src/errors.ts';
import { loadGolden } from './golden.ts';

// Codes an operation's code raises with no golden row yet (operation, code, where it's raised): golden rows to add.
// Each is exempt until its row lands, and this test says when one has, so the list only shrinks. One addition since it
// was made: accept_held_update's not_installed (the approved API page lists it; its golden row is asked for).
const MISSING_GOLDENS: [op: string, code: string, where: string][] = [
  ['publish_skill_to_catalog', 'unauthenticated', 'publish-folder.ts → catalog.publish → checkActor'],
  ['publish_skill_to_catalog', 'not_owner', 'publish-folder.ts → catalog.publish (preview_expect preview-not-owner runs once the preview is its own tool)'],
  ['publish_skill_to_catalog', 'invalid_manifest', 'publish-folder.ts → checkManifest (preview-invalid-manifest, pending until the preview is its own tool)'],
  ['publish_skill_to_catalog', 'invalid_name', 'publish-folder.ts → checkManifest: the manifest\'s name'],
  ['publish_skill_to_catalog', 'invalid_path', 'publish-folder.ts readFolder: a link, a hard link or a special file'],
  ['publish_skill_to_catalog', 'too_large', 'publish-folder.ts readChecked: a file over the limit; checkTree'],
  ['publish_skill_to_catalog', 'secret_suspected', 'catalog.publish dry run (preview-secret, pending until the preview is its own tool)'],
  ['install_shared_skill', 'not_found', 'installer.ts → catalog.versions / fetch: no such skill'],
  ['install_shared_skill', 'invalid_manifest', 'installer.ts fetchChecked → checkManifest'],
  ['install_shared_skill', 'too_large', 'installer.ts fetchChecked → checkTree'],
  ['install_shared_skill', 'name_in_use', 'installer.ts checkTarget: a skill or command of that name in the other target'],
  ['install_shared_skill', 'target_unavailable', 'installer.ts skillsFolderFor: the target\'s root can\'t be made'],
  ['install_shared_skill', 'lock_busy', 'lock.ts: another run holds the lock'],
  ['update_installed_skills', 'not_found', 'installer.ts allVersions → catalog.versions: installed from a catalog that no longer has it'],
  ['accept_held_update', 'not_installed', 'cli/commands/update.ts: update <name> --accept for a skill that isn\'t installed'],
  ['accept_held_update', 'not_found', 'installer.ts → catalog.fetch: the held version'],
  ['accept_held_update', 'invalid_manifest', 'installer.ts fetchChecked → checkManifest'],
  ['accept_held_update', 'invalid_name', 'installer.ts fetchChecked → checkName'],
  ['accept_held_update', 'invalid_path', 'installer.ts fetchChecked → checkTree'],
  ['accept_held_update', 'too_large', 'installer.ts fetchChecked → checkTree'],
  ['accept_held_update', 'fingerprint_mismatch', 'installer.ts fetchChecked'],
  ['accept_held_update', 'exists_untracked', 'installer.ts writeSkill'],
  ['accept_held_update', 'name_in_use', 'installer.ts checkTarget'],
  ['accept_held_update', 'target_symlink', 'installer.ts checkTarget / writeSkill'],
  ['accept_held_update', 'target_changed', 'installer.ts writeSkill'],
  ['accept_held_update', 'target_not_private', 'installer.ts notPrivate'],
  ['accept_held_update', 'target_unavailable', 'installer.ts skillsFolderFor'],
  ['accept_held_update', 'lock_busy', 'lock.ts'],
  ['list_installed_skills', 'not_found', 'installer.ts list → catalog.versions: installed from a catalog that no longer has it'],
  ['set_skill_update_policy', 'lock_busy', 'lock.ts'],
];

// Where a golden error belongs, when its row doesn't say: by section (longest prefix first).
const SECTION_OP: [section: string, op: string][] = [
  ['skills.invalid', 'publish_version'],
  ['skills.hostile', 'publish_version'],
  ['skills.missing-names', 'read_shared_skill'],
  ['skills.reads', 'read_shared_skill'],
  ['skills.search_filters', 'search_shared_skills'],
  ['skills.one_line_fields.message', 'publish_version'],
  ['skills.one_line_fields.developer_name', 'any'], // the demo-developer setting: every call (COMMON_ERRORS)
  ['skills.publish_steps', 'publish_skill_to_catalog'],
  ['histories.histories.concurrent', 'publish_version'],
  ['histories.histories.h1', 'publish_version'],
  ['histories.histories.owner', 'publish_version'],
  ['policy.accept_cases', 'accept_held_update'],
];
// Not errors a call raises: a version stored under older rules names the rule in its data; a fault row expects any failure.
const NOT_RAISED = ['histories.histories.older_rules', 'histories.histories.fault'];
// A row's own key says which call raised it (an install, an update and its refused skills, an accept), as does `call`.
const KEY_OP: Record<string, string> = { install: 'install_shared_skill', update: 'update_installed_skills', accept: 'accept_held_update', then_accept: 'accept_held_update' };
const CALL_OP: Record<string, string> = { update: 'update_installed_skills', install: 'install_shared_skill', accept: 'accept_held_update' };

function goldenErrors(): Map<string, Set<string>> {
  const seen = new Map<string, Set<string>>();
  const add = (op: string, code: string) => seen.set(op, (seen.get(op) ?? new Set()).add(code));
  const walk = (node: unknown, path: string[], op: string | undefined) => {
    if (Array.isArray(node)) return node.forEach((v) => walk(v, path, op));
    if (!node || typeof node !== 'object') return;
    const o = node as Record<string, unknown>;
    if ('pending' in o) return; // not built yet: its harness skips it
    if (typeof o['call'] === 'string') op = CALL_OP[o['call']] ?? o['call'];
    for (const [k, v] of Object.entries(o)) {
      // On this line the preview is publish_skill_to_catalog without a confirm; its harness reads preview_expect once the
      // preview is its own tool, so those rows aren't driven yet (MISSING_GOLDENS names them).
      if (k === 'preview_expect') continue;
      // A skill an update refuses is a line in its successful answer (contract §3), not an error the call raises.
      if (k === 'refused') continue;
      if (k === 'error' && typeof v === 'string') {
        const section = path.join('.');
        if (v === 'any' || NOT_RAISED.some((s) => section.startsWith(s))) continue;
        const target = op ?? SECTION_OP.filter(([s]) => section.startsWith(s)).sort((a, b) => b[0].length - a[0].length)[0]?.[1];
        if (!target) throw new Error(`a golden error with no operation: ${section} (${v}); place it in SECTION_OP`);
        if (target !== 'any') add(target, v);
      } else if (k === 'expect_every_command' && Array.isArray(o['commands'])) {
        const code = (v as { error?: string }).error!;
        for (const c of o['commands'] as string[]) if (OPERATIONS[c]) add(c, code);
      } else walk(v, path.length < 3 ? [...path, k] : path, KEY_OP[k] ?? op);
    }
  };
  for (const file of ['skills', 'histories', 'policy']) walk(loadGolden(`${file}.yaml`), [file], undefined);
  return seen;
}

describe('each operation\'s errors, proved by the golden error rows', () => {
  const seen = goldenErrors();
  const missing = (op: string) => MISSING_GOLDENS.filter(([o]) => o === op).map(([, c]) => c);

  it('every code the goldens expect of an operation is in its list, or one any call can return', () => {
    for (const [op, codes] of seen) {
      expect(OPERATIONS[op], `golden rows for ${op}, which isn't an operation`).toBeDefined();
      const allowed = new Set<string>([...OPERATIONS[op]!.errors, ...COMMON_ERRORS]);
      expect([op, [...codes].filter((c) => !allowed.has(c)).sort()]).toEqual([op, []]);
    }
  });

  it('every code in an operation\'s list is reached by a golden row, or named in MISSING_GOLDENS', () => {
    for (const def of Object.values(OPERATIONS)) {
      const reached = seen.get(def.name) ?? new Set();
      expect([def.name, def.errors.filter((c) => !reached.has(c) && !missing(def.name).includes(c))]).toEqual([def.name, []]);
    }
  });

  it('MISSING_GOLDENS names only listed codes with no golden row yet (drop one once its row lands)', () => {
    for (const [op, code] of MISSING_GOLDENS) {
      expect([op, code, OPERATIONS[op]?.errors.includes(code as never)]).toEqual([op, code, true]);
      expect([op, code, seen.get(op)?.has(code) ?? false]).toEqual([op, code, false]);
    }
  });

  it('no operation repeats a code any call can return, or lists one twice', () => {
    for (const def of Object.values(OPERATIONS)) {
      expect([def.name, def.errors.filter((c) => (COMMON_ERRORS as readonly string[]).includes(c))]).toEqual([def.name, []]);
      expect([def.name, def.errors.length]).toEqual([def.name, new Set(def.errors).size]);
    }
  });
});
