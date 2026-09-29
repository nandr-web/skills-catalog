// Usage metrics, the `use` event (contract §3): every operation on any face records one, with the registry's name and a
// result code: an error's code, the operation's outcome where it has one (a search's match), or "ok". Never the query,
// a name or a path. And the outcome a face acts on: the CLI's read exits 1 when none of its names is found (§1).
import { describe, expect, it } from 'vitest';
import { readUsage } from '../src/usage/record.ts';
import { cli } from './cli-io.ts';
import { seed } from './seed.ts';
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
