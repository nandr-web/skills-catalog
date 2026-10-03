// Who acts on a local catalog (contract §7, the Identity row; a recorded decision: "keep authentication, but locally it can be mocked /
// simplified"): one source for the MCP server, the CLI and the web API. SKILLS_AS (or the CLI's --as) first, then setup's
// `me` in config.json, then this computer's login made into a developer name. The login default says so on every result,
// once, in its own discreet line. A hosted catalog's identity is its sign-in, never a local default.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { actingLine, perform, contextFor } from '../src/operations.ts';
import { machineDeveloper, settingsFrom } from '../src/settings.ts';
import { open, seed, skillMd } from './seed.ts';
import { PROCESS_TEST_MS, place, startServer, type Place, type Server } from './server.ts';

vi.setConfig({ testTimeout: PROCESS_TEST_MS });

const S = Words.load();
const P = S.names['publish']!;
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function config(p: Place, value: unknown) {
  mkdirSync(p.home, { recursive: true });
  writeFileSync(join(p.home, 'config.json'), typeof value === 'string' ? value : JSON.stringify(value));
}
const envOf = (p: Place, extra: Record<string, string> = {}) => ({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, ...extra });

function skillFolder(p: Place, name: string): string {
  const dir = join(p.dir, 'work', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name, `The ${name} skill.`, 'Body.\n'));
  return dir;
}

describe('the login made into a developer name', () => {
  it('lowercases, turns any run of other characters into one hyphen, trims hyphens and keeps 64 characters at most', () => {
    expect(machineDeveloper({ USER: 'nan' })).toBe('nan');
    expect(machineDeveloper({ USER: 'Nan.D' })).toBe('nan-d');
    expect(machineDeveloper({ USER: 'john_smith--2' })).toBe('john-smith-2');
    expect(machineDeveloper({ USER: 'Zoë' })).toBe('zoe');
    expect(machineDeveloper({ USER: `${'a'.repeat(63)}_b` })).toBe('a'.repeat(63));
    expect(machineDeveloper({ USER: '___' })).toBeUndefined();
    expect(machineDeveloper({ USER: '', LOGNAME: 'ana' })).toBe('ana');
    expect(machineDeveloper({})).toBeUndefined();
  });
});

describe('settings: one identity source', () => {
  it('SKILLS_AS first, then config.json\'s me, then the login; each says where it came from', () => {
    const p = place();
    config(p, { me: 'ana' });
    expect(settingsFrom(envOf(p, { SKILLS_AS: 'bob', USER: 'nan' }), p.dir)).toMatchObject({ developer: 'bob', developerSource: 'env' });
    expect(settingsFrom(envOf(p, { USER: 'nan' }), p.dir)).toMatchObject({ developer: 'ana', developerSource: 'config' });
    const q = place();
    expect(settingsFrom(envOf(q, { USER: 'Nan' }), q.dir)).toMatchObject({ developer: 'nan', developerSource: 'machine' });
    expect(settingsFrom(envOf(q), q.dir).developer).toBeUndefined();
  });

  it('a SKILLS_AS that isn\'t a name stays a setting to fix: no fallback hides it', () => {
    const p = place();
    config(p, { me: 'ana' });
    const s = settingsFrom(envOf(p, { SKILLS_AS: 'Bad Name', USER: 'nan' }), p.dir);
    expect(s.developer).toBeUndefined();
    expect(s.developerInvalid).toBe(true);
  });

  it('a hosted catalog never takes config.json\'s me or the login: its sign-in says who acts', () => {
    const p = place();
    config(p, { me: 'ana' });
    const s = settingsFrom(envOf(p, { SKILLS_CATALOG: 'https://catalog.example', USER: 'nan' }), p.dir);
    expect(s.developer).toBeUndefined();
  });

  it('a config.json that can\'t be read gives no name from it (the installer names the damage); the login still acts', () => {
    const p = place();
    config(p, 'not json');
    expect(settingsFrom(envOf(p, { USER: 'nan' }), p.dir)).toMatchObject({ developer: 'nan', developerSource: 'machine' });
  });

  it('config.json\'s catalog is where the catalog lives when SKILLS_CATALOG isn\'t set', () => {
    const p = place();
    config(p, { catalog: 'file:///somewhere/else' });
    expect(settingsFrom({ SKILLS_HOME: p.home }, p.dir).catalog).toBe('file:///somewhere/else');
    expect(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl }, p.dir).catalog).toBe(p.catalogUrl);
  });
});

describe('the acting line', () => {
  it('a name from SKILLS_AS or setup reads "Acting as"; the login default reads as a local sign-in, once', () => {
    const p = place();
    expect(actingLine(S, settingsFrom(envOf(p, { SKILLS_AS: 'bob' }), p.dir))).toBe(S.format(S.word('acting_as'), { developer: 'bob' }));
    const local = actingLine(S, settingsFrom(envOf(p, { USER: 'nan' }), p.dir))!;
    expect(local).toBe(S.format(S.word('acting_as_local'), { developer: 'nan' }));
    expect(local).toContain('nan');
    expect(local).toMatch(/demo/);
    expect(actingLine(S, settingsFrom(envOf(p), p.dir))).toBeUndefined();
  });

  it('a result with the login default carries the local line exactly once, and never the plain one', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = contextFor(settingsFrom(envOf(p, { USER: 'nan' }), p.dir), S, 'cli');
    try {
      const a = await perform(ctx, 'search_shared_skills', 'search', { query: 'notes' });
      const line = S.format(S.word('acting_as_local'), { developer: 'nan' });
      expect(a.text.split(line).length - 1).toBe(1);
      expect(a.text).not.toContain(S.format(S.word('acting_as'), { developer: 'nan' }));
    } finally {
      close();
    }
  });
});

describe('UC-01 on the README\'s default install: publish over MCP with no SKILLS_AS', () => {
  it('with only setup\'s me in config.json, the preview and the publish act as that developer', async () => {
    const p = place();
    await seed(p);
    config(p, { me: 'ana' });
    const s = startServer(p, {});
    servers.push(s);
    await s.initialize();
    const r = await s.call(P, { folder: skillFolder(p, 'anas-notes') });
    expect(r.isError, r.content[0]!.text).toBeFalsy();
    expect(r.content[0]!.text).toContain(S.format(S.word('acting_as'), { developer: 'ana' }));
  });

  it('with no setup at all, the login acts, says so once, and the version is published as it', async () => {
    const p = place();
    await seed(p);
    const s = startServer(p, { USER: 'Nan' });
    servers.push(s);
    await s.initialize();
    const dir = skillFolder(p, 'nans-notes');
    const preview = await s.call(P, { folder: dir });
    expect(preview.isError, preview.content[0]!.text).toBeFalsy();
    const line = S.format(S.word('acting_as_local'), { developer: 'nan' });
    expect(preview.content[0]!.text.split(line).length - 1).toBe(1);
    const m = /confirm "([^"]*)", name "([^"]*)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(preview.content[0]!.text)!;
    const done = await s.call(P, { folder: dir, confirm: m[1], name: m[2], version: Number(m[3]), files: Number(m[4]), flags: JSON.parse(m[5]!) });
    expect(done.isError, done.content[0]!.text).toBeFalsy();
    const c = await open(p);
    try {
      expect((await c.versions({ name: 'nans-notes' })).versions[0]!.publisher).toBe('nan');
    } finally {
      c.close();
    }
  });

  it('with nothing to go on, the refusal names only what exists: setup, or SKILLS_AS', async () => {
    const p = place();
    await seed(p);
    const s = startServer(p, {});
    servers.push(s);
    await s.initialize();
    const r = await s.call(P, { folder: skillFolder(p, 'nobodys-notes') });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toBe(S.word('errors.unauthenticated_local'));
    expect(r.content[0]!.text).toContain('SKILLS_AS');
  });
});
