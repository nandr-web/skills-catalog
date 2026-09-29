// Usage metrics, the `use` event (contract §3): every operation on any face records one, with the API's name and a
// result code: an error's code, the operation's outcome where it has one (a search's match), or "ok". Never the query,
// a name or a path. And the outcome a face acts on: the CLI's read exits 1 when none of its names is found (§1).
import { actAs, Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, perform } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { readUsage } from '../src/usage/record.ts';
import { cli } from './cli-io.ts';
import { open, request, seed, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const uses = (p: Place) => readUsage(p.home).flatMap((e) => (e.event === 'use' ? [[e.op, e.result]] : []));

describe('the use event', () => {
  it('records each operation with its result code, and nothing it was asked', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['search', 'release', 'notes']);
    await cli(p, ['search', 'graphql', 'schema', 'federation']);
    await cli(p, ['search', 'zzz-nothing-like-this']);
    await cli(p, ['read', 'release-notes-kit']);
    await cli(p, ['versions', 'release-notes-kit']);
    await cli(p, ['install', 'no-such-skill']);
    await cli(p, ['list']);
    expect(uses(p)).toEqual([
      ['search_shared_skills', 'all'],
      ['search_shared_skills', 'partial'],
      ['search_shared_skills', 'none'],
      ['read_shared_skill', 'ok'],
      ['list_shared_skill_versions', 'ok'],
      ['install_shared_skill', 'not_found'],
      ['list_installed_skills', 'ok'],
    ]);
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const text = readdirSync(join(p.home, 'usage')).map((f) => readFileSync(join(p.home, 'usage', f), 'utf8')).join('');
    expect(text).not.toMatch(/release|notes|graphql|schema|zzz|no-such/);
  });

  it('installs and updates count by what happened: installed or held, updated or up to date, taken after a yes', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    await cli(p, ['install', 'release-notes-kit']);
    await cli(p, ['update']);
    const c = await open(p);
    try {
      await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.', 'Second.\n') }]), actAs('ben'));
    } finally {
      c.close();
    }
    await cli(p, ['update']);
    await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['y'] });
    expect(uses(p)).toEqual([
      ['install_shared_skill', 'installed'],
      ['install_shared_skill', 'held'],
      ['update_installed_skills', 'unchanged'],
      ['update_installed_skills', 'updated'],
      ['accept_held_update', 'installed'],
    ]);
  });

  it('update --accept counts once however it ends: no terminal, a no, nothing held', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    await cli(p, ['install', 'sql-migration-helper']);
    await cli(p, ['update', 'release-notes-kit', '--accept']);
    await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['n'] });
    await cli(p, ['update', 'sql-migration-helper', '--accept'], { tty: true, answers: ['y'] });
    await cli(p, ['update', 'demo-skill-01', '--accept'], { tty: true, answers: ['y'] });
    expect(uses(p).slice(2)).toEqual([
      ['accept_held_update', 'person_only'],
      ['accept_held_update', 'declined'],
      ['accept_held_update', 'nothing_held'],
      ['accept_held_update', 'not_installed'],
    ]);
  });

  it('the assistant\'s tools count installs, updates and a held install taken the same way', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, p.dir), Words.load(), 'mcp');
    try {
      await perform(ctx, 'install_shared_skill', 'install', { name: 'sql-migration-helper' });
      const held = await perform(ctx, 'install_shared_skill', 'install', { name: 'release-notes-kit' });
      await perform(ctx, 'update_installed_skills', 'update', {});
      const [, target, version, confirm] = /target "([^"]+)", version (\d+), confirm "([^"]+)"/.exec(held.text)!;
      const flags = JSON.parse(/flags (\[[^\]]*\])/.exec(held.text)![1]!);
      await perform(ctx, 'accept_held_update', 'accept', { name: 'release-notes-kit', target, version: Number(version), confirm, flags });
    } finally {
      close();
    }
    expect(uses(p)).toEqual([
      ['install_shared_skill', 'installed'],
      ['install_shared_skill', 'held'],
      ['update_installed_skills', 'unchanged'],
      ['accept_held_update', 'installed'],
    ]);
  });

  it('the assistant\'s tools count the same way', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, p.dir), Words.load(), 'mcp');
    try {
      await perform(ctx, 'search_shared_skills', 'search', { query: 'zzz-nothing-like-this' });
      await perform(ctx, 'read_shared_skill', 'read', { name: 'no-such-skill' });
      await perform(ctx, 'read_shared_skill', 'read', { names: ['no-such-skill', 'nor-this-one'] });
    } finally {
      close();
    }
    expect(uses(p)).toEqual([
      ['search_shared_skills', 'none'],
      ['read_shared_skill', 'not_found'],
      ['read_shared_skill', 'none_found'],
    ]);
  });

  it('a read that finds none of its names exits 1; one that finds some exits 0', async () => {
    const p = place();
    await seed(p);
    const none = await cli(p, ['read', 'no-such-skill', 'nor-this-one']);
    expect(none.code).toBe(1);
    expect(none.out).toBe('');
    expect(none.err).toContain('not_found');
    const some = await cli(p, ['read', 'release-notes-kit', 'no-such-skill']);
    expect(some.code).toBe(0);
    expect(some.out).toContain('not_found');
    expect(uses(p)).toEqual([
      ['read_shared_skill', 'none_found'],
      ['read_shared_skill', 'ok'],
    ]);
  });
});
