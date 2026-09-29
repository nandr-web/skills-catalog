// Setup's plan (setup build notes §3 "Order of a run"): everything read and checked before anything is written, so any
// refusal changes nothing. Where setup works (setup-places), whether the install is safe to run at every session start
// (setup-install), then each assistant file read with the one reader and setup's entries merged into its text
// (setup-merge). The plan says, per file, what it was and the text to write (none when it already holds this run's
// entries); the executor writes it.

import { CatalogError, type Words } from '@skills-catalog/core';
import { readJsonFile, type Snapshot } from './json-file.ts';
import { allowRules, hookGroup, mcpEntry, type SetupRun } from './setup-entries.ts';
import { checkInstall } from './setup-install.ts';
import { mergeClaudeJson, mergeSettingsJson, SERVER_NAME, type Merged, type PlannedEntry } from './setup-merge.ts';
import { checkPlaces, type SetupPlaces } from './setup-places.ts';

/** `.claude.json` holds per-project state and grows (build notes, "The files"); settings files stay at §5.3's cap. */
export const CLAUDE_JSON_CAP = 32 * 1024 * 1024;
export const SETTINGS_CAP = 1024 * 1024;

export type PlanInput = {
  assistantHome: string;
  skillsHome: string;
  /** The environment setup ran with (the SKILLS_* settings it carries, CLAUDE_CONFIG_DIR, SUDO_USER). */
  env: Readonly<Record<string, string | undefined>>;
  uid: number;
  /** process.execPath and the file the package's bin names. */
  node: string;
  script: string;
  temporaryRoots: readonly string[];
  words: Words;
  /** The setup id for a first run (128 random bits in hex); a record's own id wins. */
  newId: string;
};
/** A file's plan: what it was (the text read, for the backup, and its snapshot, for the write's check) and the text to
 *  write, none when it already holds this run's entries. */
export type FilePlan = { path: string; was: Snapshot | 'absent'; read: string | undefined; text: string | undefined; entries: PlannedEntry[] };
export type FileKind = 'claudeJson' | 'settingsJson';
export type SetupPlan = {
  places: SetupPlaces;
  missing: { claudeDir: boolean; skillsHome: boolean; backups: boolean };
  id: string;
  run: SetupRun;
  /** Install folders a shared group can write, for the summary. */
  sharedGroup: string[];
  record: ReturnType<typeof checkPlaces>['record'];
  recordWas: ReturnType<typeof checkPlaces>['recordWas'];
  files: Record<FileKind, FilePlan>;
};

/** A file of the person's, read for writing: its text and snapshot, absent, or refused as unusable. */
function read(path: string, cap: number): { text: string | undefined; was: Snapshot | 'absent' } {
  const f = readJsonFile(path, cap, { forWrite: true });
  if ('why' in f) throw new CatalogError('assistant_file_unusable', { path, why: f.why });
  return 'absent' in f ? { text: undefined, was: 'absent' } : { text: f.text, was: f.snapshot };
}

/** One file read afresh and setup's entries merged into it: a first plan, or again after another writer changed it. */
export function planFile(kind: FileKind, plan: Pick<SetupPlan, 'places' | 'run' | 'record'>, words: Words): FilePlan {
  const path = plan.places[kind];
  const recorded = (plan.record?.entries ?? []).filter((e) => e.file === path);
  // A settings.json whose .claude isn't there yet reads as absent.
  const { text: before, was } = read(path, kind === 'claudeJson' ? CLAUDE_JSON_CAP : SETTINGS_CAP);
  const m: Merged =
    kind === 'claudeJson'
      ? mergeClaudeJson(before, mcpEntry(plan.run), recorded)
      : mergeSettingsJson(before, { hook: hookGroup(plan.run), rules: allowRules(words), id: plan.run.id }, recorded);
  if ('refusal' in m) {
    const r = m.refusal;
    if (r.code === 'name_taken') throw new CatalogError('name_taken', { path, name: SERVER_NAME });
    if (r.code === 'assistant_file_unusable') throw new CatalogError('assistant_file_unusable', { path, why: r.why, key: r.key });
    throw new CatalogError('internal_error', {});
  }
  return { path, was, read: before, text: m.text, entries: m.entries };
}

export function planSetup(input: PlanInput): SetupPlan {
  const { places, missing, record, recordWas } = checkPlaces({ assistantHome: input.assistantHome, skillsHome: input.skillsHome, env: input.env, uid: input.uid });
  const install = checkInstall({ node: input.node, script: input.script, temporaryRoots: input.temporaryRoots, uid: input.uid });
  const id = record?.setup_id ?? input.newId;
  const run: SetupRun = { node: install.node, script: install.script, id, env: input.env };
  const base = { places, run, record };
  const files = { claudeJson: planFile('claudeJson', base, input.words), settingsJson: planFile('settingsJson', base, input.words) };
  return { places, missing, id, run, sharedGroup: install.sharedGroup, record, recordWas, files };
}
