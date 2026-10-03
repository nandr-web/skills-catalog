// The session-start hook command (contract §3; setup build notes §10; qa/golden/setup.yaml's hook rows): nothing held,
// nothing printed; a held update, one JSON object (systemMessage for the person, additionalContext for the model);
// setup's MCP entry gone, the missing-entry line; a damaged config, its one line; anything it doesn't take, nothing;
// always exit 0, within its budget.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actAs, Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { runHook, type HookIo } from '../src/cli/hook.ts';
import { cliWords } from '../src/cli/words.ts';
import { contextFor } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = cliWords(Words.load());
const ID = '0123456789abcdef0123456789abcdef';
const envOf = (p: Place) => ({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed });

async function* input(text = '{"session_id":"s","transcript_path":"/nowhere/transcript.jsonl","hook_event_name":"SessionStart"}') {
  yield Buffer.from(text);
}
async function hook(p: Place, argv = ['session-start', '--setup-id', ID], extra: Partial<HookIo> = {}) {
  const out: string[] = [];
  const code = await runHook(argv, S, { env: envOf(p), cwd: p.dir, stdin: input(), stdout: (t) => void out.push(t), ...extra });
  return { code, out: out.join('') };
}
async function publish(p: Place, name: string, files: { path: string; text: string; mode?: string }[]) {
  const c = await open(p);
  try {
    await c.publish(request(name, files), actAs('ana'));
  } finally {
    c.close();
  }
}
const plain = (name: string) => [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`) }];
const withScript = (name: string) => [...plain(name), { path: 'scripts/run.sh', text: '#!/bin/sh\necho run\n', mode: '0755' }];

describe('the session-start hook', () => {
  it('nothing installed or held: prints nothing, exit 0', async () => {
    const p = place();
    expect(await hook(p)).toEqual({ code: 0, out: '' });
  });

  it('an update that waits for the person: one JSON object, the person\'s line and the model\'s, names and versions only', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const { ctx, close } = contextFor(settingsFrom(envOf(p), p.dir), S, 'cli');
    await MACHINE_RUNS['install_shared_skill']!(ctx, { name: 'notes-helper' });
    close();
    await publish(p, 'notes-helper', withScript('notes-helper'));
    const r = await hook(p);
    expect(r.code).toBe(0);
    const o = JSON.parse(r.out);
    const fields = { n: 1, items: 'notes-helper v1 → v2' };
    expect(o).toEqual({
      systemMessage: S.format(S.word('update.held_hook_person'), fields),
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: S.format(S.word('update.held_hook_context'), fields) },
    });
  });

  it('setup\'s MCP server entry gone from .claude.json: says so, and to run setup again', async () => {
    const p = place();
    mkdirSync(p.home, { recursive: true });
    mkdirSync(p.osHome, { recursive: true });
    const entry = { type: 'stdio', command: '/n', args: ['/s', 'mcp'], env: { SKILLS_SETUP_ID: ID } };
    writeFileSync(join(p.home, 'setup-record.json'), JSON.stringify({ version: 1, setup_id: ID, entries: [{ kind: 'mcp_entry', file: join(p.osHome, '.claude.json'), value: entry, state: 'written' }], created_files: [], backups: [] }));
    writeFileSync(join(p.osHome, '.claude.json'), JSON.stringify({ mcpServers: { 'skills-catalog': entry } }));
    expect((await hook(p)).out).toBe('');
    writeFileSync(join(p.osHome, '.claude.json'), JSON.stringify({ mcpServers: {} }));
    expect(JSON.parse((await hook(p)).out)).toEqual({ systemMessage: S.format(S.setup.hook_entry_missing, { path: join(p.osHome, '.claude.json') }) });
  });

  it('a damaged config.json: its one line for the person, exit 0', async () => {
    const p = place();
    mkdirSync(p.home, { recursive: true });
    writeFileSync(join(p.home, 'config.json'), 'not json');
    const r = await hook(p);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).systemMessage).toMatch(/^invalid_local_file: /);
  });

  it('anything else on its command line: nothing, exit 0', async () => {
    const p = place();
    for (const argv of [[], ['session-end', '--setup-id', ID], ['session-start', '--setup-id', 'x'], ['session-start', '--setup-id', ID, 'extra']]) expect(await hook(p, argv)).toEqual({ code: 0, out: '' });
  });

  it('a sync that takes too long is given up: nothing printed, exit 0, within the budget', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const t = Date.now();
    const r = await hook(p, undefined, { budgetMs: 0 });
    expect(r).toEqual({ code: 0, out: '' });
    expect(Date.now() - t).toBeLessThan(2500);
  });
});
