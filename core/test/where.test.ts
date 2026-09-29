// Where the catalog runs (contract §1.1): locally, or hosted. It's said when the catalog is opened, never inferred; an
// operation may be hosted only (`where: 'hosted'`), and an input may take another form when hosted (`hostedForm`),
// each form refusing the other. Faces say who calls; this says where the catalog runs.
import { describe, expect, it } from 'vitest';
import { inputSchema, validateInput, type OperationDef } from '../src/api.ts';
import { Catalog, type CatalogPorts } from '../src/catalog.ts';
import { actAs } from '../src/local/index.ts';
import { openapi } from '../src/openapi.ts';
import type { BlobLinks, Storage } from '../src/ports.ts';
import { counterIds, errorOf, fixedClock, openTest } from './helpers.ts';

// A row with both kinds, as the hosted publish and the upload links will have them.
const PUT: OperationDef = {
  name: 'put_thing',
  kind: 'catalog',
  phase: 'aws',
  faces: ['web'],
  effect: 'writes_catalog',
  run: 'put',
  output: { type: 'object', properties: {}, required: [], additionalProperties: false },
  errors: [],
  input: {
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content_base64: { type: 'string' } }, required: ['path', 'content_base64'] } }, secret: { type: 'boolean' } },
    required: ['files'],
  },
  hostedForm: { files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, sha256: { type: 'string', maxLength: 64 } }, required: ['path', 'sha256'] } } },
  cliOnly: ['secret'],
};
const LINKS: OperationDef = { ...PUT, name: 'links_for_things', effect: 'reads', run: 'links', where: 'hosted', hostedForm: undefined, input: { type: 'object', properties: { name: { type: 'string' } } } };

const local = { files: [{ path: 'SKILL.md', content_base64: 'eA==' }] };
const hosted = { files: [{ path: 'SKILL.md', sha256: 'a'.repeat(64) }] };

describe('an input\'s hosted form', () => {
  it('each place sees its own form, and the face\'s rule still applies', () => {
    expect(inputSchema(PUT, 'web', 'local').properties['files']).toBe(PUT.input.properties['files']);
    expect(inputSchema(PUT, 'web', 'hosted').properties['files']).toBe(PUT.hostedForm!['files']);
    for (const where of ['local', 'hosted'] as const) expect([where, 'secret' in inputSchema(PUT, 'web', where).properties]).toEqual([where, false]);
    expect('secret' in inputSchema(PUT, 'cli', 'hosted').properties).toBe(true);
  });

  it('each form refuses the other with unknown_field', async () => {
    expect(validateInput(PUT, local, 'web', 'local')).toEqual(local);
    expect(validateInput(PUT, hosted, 'web', 'hosted')).toEqual(hosted);
    const onLocal = await errorOf(() => validateInput(PUT, hosted, 'web', 'local'));
    expect([onLocal.code, onLocal.data]).toEqual(['invalid_request', { field: 'files[0].sha256', why: 'unknown_field' }]);
    const onHosted = await errorOf(() => validateInput(PUT, local, 'web', 'hosted'));
    expect([onHosted.code, onHosted.data]).toEqual(['invalid_request', { field: 'files[0].content_base64', why: 'unknown_field' }]);
  });
});

describe('a hosted-only operation', () => {
  it('is checked hosted, and never reached on a local catalog: no face there offers it', async () => {
    expect(validateInput(LINKS, { name: 'x' }, 'web', 'hosted')).toEqual({ name: 'x' });
    expect(() => validateInput(LINKS, { name: 'x' }, 'web', 'local')).toThrow(/links_for_things is hosted only/);
  });

  it('is in the hosted schema and not in the local one', () => {
    const ops = { put_thing: PUT, links_for_things: LINKS };
    expect(Object.keys((openapi('local', ops) as any).paths)).toEqual(['/api/v1/put_thing', '/api/v1/files/{sha256}']);
    expect(Object.keys((openapi('hosted', ops) as any).paths)).toEqual(['/api/v1/put_thing', '/api/v1/links_for_things', '/api/v1/files/{sha256}']);
    const files = (where: 'local' | 'hosted') => (openapi(where, ops) as any).components.schemas.put_thing_input.properties.files.items.properties;
    expect(Object.keys(files('local'))).toEqual(['path', 'content_base64']);
    expect(Object.keys(files('hosted'))).toEqual(['path', 'sha256']);
  });
});

describe('where the catalog runs is said when it\'s opened', () => {
  const ports = (where: 'local' | 'hosted', links?: BlobLinks): CatalogPorts => ({
    where,
    storage: {} as Storage,
    index: {} as never,
    events: { subscribe: () => {}, deliver: async () => 0 },
    identity: actAs(undefined),
    clock: fixedClock(),
    ids: counterIds(),
    ...(links ? { links } : {}),
  });
  const links: BlobLinks = { downloadLink: async (s) => s };

  it('a hosted catalog needs its links, and a local one has none', async () => {
    expect((await Catalog.open(ports('hosted', links))).where).toBe('hosted');
    expect((await Catalog.open(ports('local'))).where).toBe('local');
    await expect(Catalog.open(ports('hosted'))).rejects.toThrow(/hosted catalog needs a links port/);
    await expect(Catalog.open(ports('local', links))).rejects.toThrow(/local catalog has no links port/);
  });

  it('the local catalog says it\'s local', async () => {
    const { catalog } = await openTest();
    expect(catalog.where).toBe('local');
    catalog.close();
  });
});
