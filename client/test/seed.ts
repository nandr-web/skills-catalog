// A small catalog for the MCP tests, published through the core itself: two developers' skills, one with two versions
// (the second adds a script), and a dozen more so a listing has a second page.
import { actAs, openLocalCatalog, type Catalog } from '@skills-catalog/core';
import type { Place } from './server.ts';

export const skillMd = (name: string, description: string, body = 'Body.\n') => `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

type File = { path: string; text: string; mode?: string };
export const request = (name: string, files: File[], message?: string) => ({
  name,
  files: files.map((f) => ({ path: f.path, mode: f.mode ?? '0644', content_base64: Buffer.from(f.text).toString('base64') })),
  ...(message === undefined ? {} : { message }),
});

const clock = () => {
  let t = Date.parse('2026-09-28T12:00:00Z');
  return { now: () => new Date((t += 60_000)) };
};

export const open = (p: Place): Promise<Catalog> => openLocalCatalog(p.catalogDir, { clock: clock() });

export async function seed(p: Place, extra: (c: Catalog) => Promise<void> = async () => {}): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request('release-notes-kit', [{ path: 'SKILL.md', text: skillMd('release-notes-kit', 'Draft release notes from merged pull requests.') }], 'First version.'), actAs('ana'));
    await c.publish(
      request(
        'release-notes-kit',
        [
          { path: 'SKILL.md', text: skillMd('release-notes-kit', 'Draft release notes and a changelog from merged pull requests.', 'Body, second version.\n') },
          { path: 'scripts/collect.sh', text: '#!/bin/sh\necho collecting\n', mode: '0755' },
        ],
        'Adds a collector script.',
      ),
      actAs('ana'),
    );
    await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.') }]), actAs('ben'));
    for (let i = 1; i <= 12; i++) {
      const name = `demo-skill-${String(i).padStart(2, '0')}`;
      await c.publish(request(name, [{ path: 'SKILL.md', text: skillMd(name, `Demo skill number ${i}.`) }]), actAs('ben'));
    }
    await extra(c);
  } finally {
    c.close();
  }
}
