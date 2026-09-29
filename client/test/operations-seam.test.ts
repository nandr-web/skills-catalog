// One definition runs every face (contract §1; the API build brief's API-2): each row names its run function, a Catalog
// method for a catalog operation or an export of machine/index.ts for a machine one; `perform` runs it and gets data
// back, and each face presents that data its own way (the MCP's and the CLI's text, byte for byte as before, which the
// golden transcripts prove; the web face never presents: it sends the data). An operation a face doesn't serve is
// refused there.
import { OPERATIONS, Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { MACHINE } from '../src/machine/index.ts';
import { contextFor, perform, type Face } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, seed } from './seed.ts';
import { place, type Place } from './server.ts';

const ctxFor = (p: Place, face: Face) => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, p.dir), Words.load(), face);
type Row = { run?: string; faces?: readonly string[] };

describe('each operation\'s row names what runs it', () => {
  it('every row with a face names one function: a Catalog method for a catalog row, an export of machine/index.ts for a machine row', async () => {
    const p = place();
    await seed(p);
    const catalog = (await open(p)) as unknown as Record<string, unknown>;
    try {
      const served = Object.entries(OPERATIONS as Record<string, Row>).filter(([, row]) => (row.faces ?? []).length > 0);
      expect(served.length).toBeGreaterThan(0);
      for (const [op, row] of served) {
        expect(typeof row.run, op).toBe('string');
        const onCatalog = typeof catalog[row.run!] === 'function';
        const onMachine = Object.hasOwn(MACHINE, row.run!) && typeof (MACHINE as Record<string, unknown>)[row.run!] === 'function';
        expect([op, onCatalog !== onMachine], op).toEqual([op, true]);   // exactly one of them
      }
    } finally {
      (catalog as unknown as { close(): void }).close();
    }
  });
});

describe('perform', () => {
  it('returns the operation\'s data beside the face\'s text', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = ctxFor(p, 'mcp');
    try {
      const a = await perform(ctx, 'search_shared_skills', 'search_shared_skills', { query: 'release notes' });
      expect(a.isError).toBe(false);
      expect(a.text).not.toBe('');
      expect(a.data).toMatchObject({ total_matches: expect.any(Number), skills: expect.any(Array) });
    } finally {
      close();
    }
  });

  it('on the web face, gives the data and presents nothing', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = ctxFor(p, 'web');
    try {
      const a = await perform(ctx, 'search_shared_skills', 'search_shared_skills', { query: 'release notes' });
      expect(a.isError).toBe(false);
      expect(a.text).toBe('');
      expect(a.data).toMatchObject({ total_matches: expect.any(Number) });
    } finally {
      close();
    }
  });

  it('refuses an operation the face doesn\'t serve (the web never runs a machine operation)', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = ctxFor(p, 'web');
    try {
      await expect(perform(ctx, 'install_shared_skill', 'install_shared_skill', { name: 'release-notes-kit' })).rejects.toThrow(/not served on the web face/);
    } finally {
      close();
    }
  });
});
