// One definition runs every face (contract §1; the API build brief's API-2): each row names its run function, a Catalog
// method for a catalog operation or an export of machine/index.ts for a machine one; `perform` runs it and gets data
// back, and each face presents that data its own way (the MCP's and the CLI's text, byte for byte as before, which the
// golden transcripts prove; the web face never presents: it sends the data). An operation a face doesn't serve is
// refused there.
import { readFileSync } from 'node:fs';
import { OPERATIONS, Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { logWords } from '../src/activity.ts';
import { MACHINE } from '../src/machine/index.ts';
import { contextFor, perform, type Face } from '../src/operations.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, seed, skillMd } from './seed.ts';
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
      expect(a.data).toMatchObject({ total_matches: expect.any(Number), results: expect.any(Array) });
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

  // The web face shares one catalog opened with no identity: each call acts as the developer its settings name, and each
  // Catalog method gets the caller's face in its own slot (publish's second argument is the identity, the others' the face).
  const asWeb = (p: Place) => {
    const { ctx, close } = contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_AS: 'ana' }, p.dir), Words.load(), 'web');
    const shared = open(p);
    return { ctx: { ...ctx, catalog: () => shared }, close: () => { close(); void shared.then((c) => c.close()); } };
  };
  const newSkill = (extra: Record<string, unknown> = {}) => ({ ...request('web-published', [{ path: 'SKILL.md', text: skillMd('web-published', 'Published from the web face.') }]), ...extra });

  it('publishes as the acting developer, on a catalog opened with no identity', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = asWeb(p);
    try {
      const a = await perform(ctx, 'publish_version', 'publish_version', newSkill());
      expect(a.error?.toJSON()).toBeUndefined();
      expect(a.data).toMatchObject({ name: 'web-published', version: 1, created: true, publisher: 'ana' });
    } finally {
      close();
    }
  });

  it('as the web face, refuses the person-only secret override as an unknown field', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = asWeb(p);
    try {
      const a = await perform(ctx, 'publish_version', 'publish_version', newSkill({ allow_suspected_secrets: true }));
      expect(a.isError).toBe(true);
      expect(a.error?.toJSON()).toMatchObject({ code: 'invalid_request', field: 'allow_suspected_secrets', why: 'unknown_field' });
    } finally {
      close();
    }
  });

  it('logs a web fetch as fetched, with the version it fetched', async () => {
    const p = place();
    await seed(p);
    const { ctx, close } = asWeb(p);
    try {
      const a = await perform(ctx, 'fetch_version', 'fetch_version', { name: 'release-notes-kit', version: 1 });
      expect(a.error?.toJSON()).toBeUndefined();
      const line = readFileSync(ctx.settings.activityLog, 'utf8').trim().split('\n').at(-1)!;
      expect(line).toContain('release-notes-kit v1');
      expect(line).toContain(logWords(Words.load()).result('fetch'));
    } finally {
      close();
    }
  });
});
