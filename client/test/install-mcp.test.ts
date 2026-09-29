// The installer over MCP, end to end through the real server on stdio (contract §3): install a skill, a held first install
// taken with the person's yes, an update, and the list. The server's HOME is the sandbox's, so the user target's skills
// folder is inside it too.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Words } from '@skills-catalog/core';
import { afterEach, describe, expect, it } from 'vitest';
import { open, request, seed, skillMd } from './seed.ts';
import { place, startServer, type Place, type Server } from './server.ts';
import { actAs } from '@skills-catalog/core';

const S = Words.load();
const N = S.names as Record<'install' | 'update' | 'accept' | 'status', string>;
const LOG = S.fill(S.doc.log) as { result: Record<string, any> };

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});
function start(p: Place): Server {
  const s = startServer(p);
  servers.push(s);
  return s;
}

const skills = (p: Place) => join(p.osHome, '.claude', 'skills');
const confirmOf = (text: string) => /confirm "([^"]+)"/.exec(text)?.[1];

describe('the installer over MCP', () => {
  it('installs, holds a skill with a script until the yes, updates, and lists; each call in the activity log', async () => {
    const p = place();
    await seed(p);
    const s = start(p);
    await s.initialize();

    const plain = await s.call(N.install, { name: 'sql-migration-helper' });
    expect(plain.isError).toBeUndefined();
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).toBe(skillMd('sql-migration-helper', 'Write and review SQL schema migrations.'));

    // release-notes-kit v2 adds scripts/collect.sh (0755): a first install from nothing holds on it.
    const held = await s.text(N.install, { name: 'release-notes-kit' });
    expect(existsSync(join(skills(p), 'release-notes-kit'))).toBe(false);
    // The four values as the held line gives them, as an assistant copies them.
    const [, target, version] = /target "([^"]+)", version (\d+)/.exec(held)!;
    const taken = await s.call(N.accept, { name: 'release-notes-kit', target, version: Number(version), confirm: confirmOf(held)!, flags: ['runnable_file'] });
    expect(taken.isError).toBeUndefined();
    expect(readFileSync(join(skills(p), 'release-notes-kit', 'scripts', 'collect.sh'), 'utf8')).toBe('#!/bin/sh\necho collecting\n');

    const c = await open(p);
    try {
      await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.', 'Second.\n') }]), actAs('ben'));
    } finally {
      c.close();
    }
    const updated = await s.text(N.update, {});
    expect(updated).toContain(S.format(S.word('update.updated'), { name: 'sql-migration-helper', from: 1, to: 2, changes: '"SKILL.md" changed' }));
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).toContain('Second.');

    const listed = await s.call(N.status, {});
    expect(listed.isError).toBeUndefined();

    const log = readFileSync(join(p.home, 'activity.log'), 'utf8').trim().split('\n');
    expect(log.map((l) => l.split(/\s{2,}/)[2])).toEqual([N.install, N.install, N.accept, N.update, N.status]);
    expect(log[1]).toContain(LOG.result.install.held);
    expect(log[2]).toContain(LOG.result.accept);
  });
});
