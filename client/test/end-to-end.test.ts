// The PRD's first goal, end to end, through the assistant's own tools ("Developer 1 publishes a skill; Developer 2,
// through an AI assistant, discovers and retrieves the same skill, no file handoff, no repo sharing"): two developers,
// each with their own machine (their own SKILLS_HOME and home folder) and their own MCP server, sharing only the
// catalog. ana publishes ./release-note-draft; bob's server, asked the PRD's own question, finds it with its
// description, installs it, and has the same bytes and fingerprint ana published. The words are the PRD's I/O examples.
// What a real assistant adds on top (choosing the tools from the person's words) is the agent layer's A16.
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Words, openCatalog } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { PROCESS_TEST_MS, place, startServer } from './server.ts';

const S = Words.load();
const T = S.names as Record<string, string>;

const FILES: Record<string, string> = {
  'SKILL.md': '---\nname: release-note-draft\ndescription: Draft release notes from the merged pull requests, using the team template.\n---\nList the merged pull requests since the last tag and fill template.md.\n',
  'template.md': '# Release notes\n\n## Added\n\n## Fixed\n',
};

/** Every file under `dir`, path → sha256. */
function hashes(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(dir, r)).isDirectory()) Object.assign(out, hashes(dir, r));
    else out[r] = createHash('sha256').update(readFileSync(join(dir, r))).digest('hex');
  }
  return out;
}

describe("the PRD's end to end: Developer 1 publishes, Developer 2's assistant discovers and retrieves the same skill", () => {
  it(
    'two machines sharing only the catalog: published once by ana, found by its description and installed byte for byte by bob',
    async () => {
      const p = place();
      const folder = join(p.dir, 'ana-work', 'release-note-draft');
      mkdirSync(folder, { recursive: true });
      for (const [path, text] of Object.entries(FILES)) writeFileSync(join(folder, path), text);

      // Developer 1: preview, then publish with the preview's values (her yes).
      const ana = startServer(p, { SKILLS_AS: 'ana' });
      try {
        await ana.initialize();
        const preview = await ana.text(T['publish']!, { folder });
        const m = /confirm "([^"]+)", name "([^"]+)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(preview);
        expect(m, preview).not.toBeNull();
        const done = await ana.call(T['publish']!, { folder, confirm: m![1], name: m![2], version: Number(m![3]), files: Number(m![4]), flags: JSON.parse(m![5]!) });
        expect(done.isError, done.content[0]!.text).toBeFalsy();
      } finally {
        await ana.close();
      }

      // Developer 2: another machine (its own SKILLS_HOME and home), the same catalog, no file from ana's.
      const bob = startServer(p, { SKILLS_AS: 'bob', SKILLS_HOME: join(p.dir, 'bob-skills-home'), HOME: join(p.dir, 'bob-home'), SKILLS_ASSISTANT_HOME: join(p.dir, 'bob-home') });
      try {
        await bob.initialize();
        // FR-02's example: "is there a skill for writing release notes?" → release-note-draft with its description.
        const found = await bob.text(T['search']!, { query: 'is there a skill for writing release notes?' });
        expect(found).toContain('release-note-draft');
        expect(found).toContain('Draft release notes from the merged pull requests');
        expect(found).toContain(S.format(S.word('acting_as'), { developer: 'bob' }));
        // FR-03's example: "get me the release-note-draft skill" → the skill, intact and ready to use.
        const got = await bob.text(T['install']!, { name: 'release-note-draft' });
        const to = / to ("(?:[^"\\]|\\.)*")/.exec(got);
        expect(to, got).not.toBeNull();
        const installed = JSON.parse(to![1]!) as string;
        expect(installed.startsWith(join(p.dir, 'bob-home'))).toBe(true);
        expect(hashes(installed)).toEqual(hashes(folder));
      } finally {
        await bob.close();
      }

      // The same version: what bob has is what the catalog keeps as ana's v1 (its fingerprint, its publisher).
      const catalog = await openCatalog(p.catalogUrl);
      try {
        const v = (await catalog.versions({ name: 'release-note-draft' })).versions;
        expect(v.map((x) => [x.version, x.publisher])).toEqual([[1, 'ana']]);
      } finally {
        catalog.close();
      }
    },
    PROCESS_TEST_MS,
  );
});
