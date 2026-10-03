// Setup's plan (setup build notes §3 "Order of a run": everything read and checked first, any refusal changes nothing):
// where it works, whether the install is safe, each assistant file read with the one reader and merged; the planner
// writes nothing, whatever it finds.
import { chmodSync, linkSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, Words } from '@skills-catalog/core';
import { sandbox } from '@skills-catalog/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { race, runnerFolders } from './race-fs.ts';

// The runner's own temp folder (on Linux, /tmp, written by everyone) isn't what these tests are about (race-fs.ts).
vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
beforeEach(() => runnerFolders());
afterEach(() => {
  race.stats = undefined;
});
import { freshText } from '../src/machine/json-splice.ts';
import { allowRules, hookGroup, mcpEntry } from '../src/machine/setup-entries.ts';
import { planSetup, type PlanInput } from '../src/machine/setup-plan.ts';

const S = Words.load();
const ID = '0123456789abcdef0123456789abcdef';
const OLD_ID = 'fedcba9876543210fedcba9876543210';
const file = (path: string, text = '', mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o755 });
  writeFileSync(path, text, { mode });
};

/** A sandbox with the homes (the skills home missing, as on a first run) and an installed package with its node. */
function world() {
  const dir = sandbox();
  const A = join(dir, 'home');
  const H = join(dir, 'skills-home');
  mkdirSync(A, { mode: 0o700 });
  const pkg = join(dir, 'pkg');
  file(join(pkg, 'package.json'), '{"name": "skills-catalog"}');
  file(join(pkg, 'src', 'cli.ts'));
  const node = join(dir, 'node-bin', 'node');
  file(node, '', 0o755);
  const temp = join(sandbox(), 'temp');
  const input: PlanInput = { assistantHome: A, skillsHome: H, env: { SKILLS_HOME: H, SKILLS_ASSISTANT_HOME: A, SKILLS_AS: 'someone' }, uid: process.getuid!(), node, script: join(pkg, 'src', 'cli.ts'), temporaryRoots: [temp], words: S, newId: ID };
  return { dir, A, H, input };
}
const refusal = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    if (e instanceof CatalogError) return { code: e.code, data: e.data };
    throw e;
  }
  return undefined;
};
const listing = (dir: string) => readdirSync(dir, { recursive: true }).map(String).sort();

describe('setup\'s plan: read and checked, nothing written', () => {
  it('a first run: both files new, with the entry, the hook and the rules built from this run; nothing made yet', () => {
    const { dir, A, input } = world();
    const before = listing(dir);
    const plan = planSetup(input);
    expect(plan.id).toBe(ID);
    expect(plan.run.env).toEqual({ SKILLS_HOME: input.skillsHome, SKILLS_ASSISTANT_HOME: A });
    const entry = mcpEntry(plan.run);
    // Only the settings setup carries: never SKILLS_AS.
    expect(Object.keys(entry['env'] as object)).toEqual(['SKILLS_SETUP_ID', 'SKILLS_HOME', 'SKILLS_ASSISTANT_HOME']);
    expect(plan.files.claudeJson).toEqual({ path: join(A, '.claude.json'), was: 'absent', text: freshText({ mcpServers: { 'skills-catalog': entry } }), entries: [{ kind: 'mcp_entry', value: entry, created: ['mcpServers'] }] });
    expect(plan.files.settingsJson.text).toBe(freshText({ hooks: { SessionStart: [hookGroup(plan.run)] }, permissions: { allow: allowRules(S) } }));
    expect(plan.missing).toEqual({ claudeDir: true, skillsHome: true, backups: true });
    expect(listing(dir)).toEqual(before);
  });

  it('carries each setting as the absolute place setup checked, never as given: a relative one would resolve in each project', () => {
    const { dir, input } = world();
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      const plan = planSetup({ ...input, env: { SKILLS_HOME: 'skills-home', SKILLS_MANAGED_SETTINGS: './managed', SKILLS_ACTIVITY_LOG: 'logs/a.log', SKILLS_CATALOG: 'file:///c/catalog' } });
      expect(plan.run.env).toEqual({ SKILLS_HOME: join(dir, 'skills-home'), SKILLS_MANAGED_SETTINGS: join(dir, 'managed'), SKILLS_ACTIVITY_LOG: join(dir, 'logs', 'a.log'), SKILLS_CATALOG: 'file:///c/catalog' });
    } finally {
      process.chdir(cwd);
    }
  });

  it('refuses a setting it couldn\'t carry safely: a relative install folder, a catalog that isn\'t a URL, a $, a backtick or a control character', () => {
    const { input } = world();
    expect(refusal(() => planSetup({ ...input, env: { SKILLS_INSTALL_DIR: 'skills' } }))).toEqual({ code: 'invalid_request', data: { field: 'SKILLS_INSTALL_DIR', why: 'not_absolute' } });
    expect(refusal(() => planSetup({ ...input, env: { SKILLS_CATALOG: 'catalog' } }))).toEqual({ code: 'invalid_request', data: { field: 'catalog', why: 'not_a_catalog_url' } });
    for (const v of ['/a/$HOME', '/a/`x`', '/a/\nb']) {
      expect(refusal(() => planSetup({ ...input, env: { SKILLS_HOME: v } })), JSON.stringify(v)).toEqual({ code: 'install_unsafe', data: { path: v, why: 'path_characters' } });
    }
  });

  it('an assistant home reached through a link: the places are its real folder, so each later check sees the same folder', () => {
    const { dir, A, input } = world();
    const linked = join(dir, 'linked-home');
    symlinkSync(A, linked);
    const plan = planSetup({ ...input, assistantHome: linked });
    expect(plan.places.claudeJson).toBe(join(realpathSync(A), '.claude.json'));
  });

  it('a rerun with setup\'s record: its setup id, and no file to write', () => {
    const { A, H, input } = world();
    const first = planSetup(input);
    mkdirSync(join(A, '.claude'), { mode: 0o700 });
    writeFileSync(first.files.claudeJson.path, first.files.claudeJson.text!, { mode: 0o600 });
    writeFileSync(first.files.settingsJson.path, first.files.settingsJson.text!, { mode: 0o600 });
    mkdirSync(H, { mode: 0o700 });
    const entries = [first.files.claudeJson, first.files.settingsJson].flatMap((f) => f.entries.map((e) => ({ ...e, file: f.path, state: 'written' })));
    writeFileSync(join(H, 'setup-record.json'), JSON.stringify({ version: 1, setup_id: ID, entries, created_files: [], backups: [] }), { mode: 0o600 });
    const again = planSetup({ ...input, newId: OLD_ID });
    expect(again.id).toBe(ID);
    expect([again.files.claudeJson.text, again.files.settingsJson.text]).toEqual([undefined, undefined]);
    expect(again.files.claudeJson.was).not.toBe('absent');
    // Node moved: the record makes setup's entries its own, so they're replaced where they are.
    const node2 = join(dirname(input.node), 'node2');
    file(node2, '', 0o755);
    const moved = planSetup({ ...input, node: node2 });
    expect(JSON.parse(moved.files.claudeJson.text!).mcpServers['skills-catalog'].command).toBe(node2);
    expect(JSON.parse(moved.files.settingsJson.text!).hooks.SessionStart).toEqual([hookGroup(moved.run)]);
  });

  it('an assistant file it can\'t use: assistant_file_unusable with the path, why and key, never its text', () => {
    const { A, input } = world();
    writeFileSync(join(A, '.claude.json'), 'QA-SENTINEL not json', { mode: 0o600 });
    const r = refusal(() => planSetup(input));
    expect(r).toEqual({ code: 'assistant_file_unusable', data: { path: join(A, '.claude.json'), why: 'not_json' } });
    expect(JSON.stringify(r)).not.toContain('QA-SENTINEL');
    writeFileSync(join(A, '.claude.json'), '{"mcpServers": {}, "mcpServers": {}}');
    expect(refusal(() => planSetup(input))).toEqual({ code: 'assistant_file_unusable', data: { path: join(A, '.claude.json'), why: 'duplicate_key', key: 'mcpServers' } });
    // Read as a file setup would write: a second hard link to it is refused (a write would change the other name too).
    writeFileSync(join(A, '.claude.json'), '{}');
    linkSync(join(A, '.claude.json'), join(dirname(A), 'second-name.json'));
    expect(refusal(() => planSetup(input))).toEqual({ code: 'assistant_file_unusable', data: { path: join(A, '.claude.json'), why: 'hard_linked' } });
    rmSync(join(dirname(A), 'second-name.json'));
    writeFileSync(join(A, '.claude.json'), '{}');
    mkdirSync(join(A, '.claude'), { mode: 0o700 });
    writeFileSync(join(A, '.claude', 'settings.json'), '{"permissions": {"allow": "x"}}', { mode: 0o600 });
    expect(refusal(() => planSetup(input))).toEqual({ code: 'assistant_file_unusable', data: { path: join(A, '.claude', 'settings.json'), why: 'wrong_type', key: 'permissions.allow' } });
    const outside = join(dirname(A), 'outside.json');
    writeFileSync(outside, '{}');
    rmSync(join(A, '.claude', 'settings.json'));
    symlinkSync(outside, join(A, '.claude', 'settings.json'));
    expect(refusal(() => planSetup(input))).toEqual({ code: 'assistant_file_unusable', data: { path: join(A, '.claude', 'settings.json'), why: 'link' } });
  });

  it('a skills-catalog server setup didn\'t write: name_taken with the path and the name', () => {
    const { A, input } = world();
    writeFileSync(join(A, '.claude.json'), '{"mcpServers": {"skills-catalog": {"command": "/opt/mine"}}}', { mode: 0o600 });
    expect(refusal(() => planSetup(input))).toEqual({ code: 'name_taken', data: { path: join(A, '.claude.json'), name: 'skills-catalog' } });
  });

  it('refuses before reading the assistant files when where it works, or the install, isn\'t safe', () => {
    const { A, input } = world();
    writeFileSync(join(A, '.claude.json'), 'not json', { mode: 0o600 });
    expect(refusal(() => planSetup({ ...input, env: { ...input.env, CLAUDE_CONFIG_DIR: '/c' }, assistantHome: A }))?.code).toBe('assistant_file_unusable');
    expect(refusal(() => planSetup({ ...input, env: { CLAUDE_CONFIG_DIR: '/c' } }))?.code).toBe('assistant_config_elsewhere');
    expect(refusal(() => planSetup({ ...input, temporaryRoots: [dirname(input.script)] }))).toEqual({ code: 'install_unsafe', data: { path: input.script, why: 'temporary' } });
    chmodSync(A, 0o777);
    try {
      expect(refusal(() => planSetup(input))?.code).toBe('target_not_private');
    } finally {
      chmodSync(A, 0o700);
    }
  });
});
