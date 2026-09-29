// Publishing to a hosted catalog (contract §1.1): files go up by short-lived links first (request_upload_links), then
// publish_version names each by {path, mode, sha256}. Everything else about a publish is unchanged: the order of
// refusals, the checks on the files' bytes, all or nothing, the fingerprint. A hosted fetch_version answers links
// from the version it reads, never bytes. Each place takes only its own form.

import { afterEach, describe, expect, it } from 'vitest';
import { OPERATIONS, inputSchema } from '../src/api.ts';
import { actAs } from '../src/local/index.ts';
import { openapi } from '../src/openapi.ts';
import { errorOf, openTest } from './helpers.ts';
import { openHostedStandIn, sha256Of, type StandIn } from './hosted-stand-in.ts';

const skillMd = (name: string, body = 'Body.\n') => `---\nname: ${name}\ndescription: A skill for tests.\n---\n${body}`;
const b64 = (s: string) => Buffer.from(s).toString('base64');

let open: StandIn[] = [];
async function standIn(opts: Parameters<typeof openHostedStandIn>[0] = {}): Promise<StandIn> {
  const s = await openHostedStandIn(opts);
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

/** Upload each file, then the sha256 form of a publish naming them. */
function uploaded(s: StandIn, name: string, files: { path: string; text: string; mode?: string }[], extra: Record<string, unknown> = {}) {
  return { name, files: files.map((f) => ({ path: f.path, mode: f.mode ?? '0644', sha256: s.upload(f.text) })), ...extra };
}

describe('publish_version, hosted: files named by sha256', () => {
  it('a hosted catalog takes the sha256 form: the version and its fingerprint are those of the same files published inline locally', async () => {
    const s = await standIn();
    const files = [
      { path: 'SKILL.md', text: skillMd('hosted-one') },
      { path: 'notes/a.md', text: 'Notes.\n' },
    ];
    const r = await s.catalog.publish(uploaded(s, 'hosted-one', files));
    expect([r.name, r.version, r.created]).toEqual(['hosted-one', 1, true]);

    const { catalog: local } = await openTest({ identity: actAs('dana') });
    const l = await local.publish({ name: 'hosted-one', files: files.map((f) => ({ path: f.path, mode: '0644', content_base64: b64(f.text) })) });
    local.close();
    expect(r.fingerprint).toBe(l.fingerprint);
  });

  it('the commit is given each file by its sha256 alone, never its bytes', async () => {
    const s = await standIn();
    await s.catalog.publish(uploaded(s, 'by-sha', [{ path: 'SKILL.md', text: skillMd('by-sha') }]));
    expect(s.commits).toEqual([[{ sha256: sha256Of(skillMd('by-sha')) }]]);
  });

  it('a hosted catalog refuses content_base64 (unknown_field), and a local one refuses sha256', async () => {
    const s = await standIn();
    const inline = await errorOf(() => s.catalog.publish({ name: 'x', files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('x')) }] }));
    expect([inline.code, inline.data]).toEqual(['invalid_request', { field: 'files[0].content_base64', why: 'unknown_field' }]);

    const { catalog: local } = await openTest({ identity: actAs('dana') });
    const bySha = await errorOf(() => local.publish({ name: 'x', files: [{ path: 'SKILL.md', mode: '0644', sha256: sha256Of(skillMd('x')) }] }));
    local.close();
    expect([bySha.code, bySha.data]).toEqual(['invalid_request', { field: 'files[0].sha256', why: 'unknown_field' }]);
  });

  it('a file never uploaded is not_uploaded, naming the first such file, and nothing is committed', async () => {
    const s = await standIn();
    const req = uploaded(s, 'half', [{ path: 'SKILL.md', text: skillMd('half') }]);
    req.files.push({ path: 'b.md', mode: '0644', sha256: sha256Of('never sent') }, { path: 'c.md', mode: '0644', sha256: sha256Of('nor this') });
    const e = await errorOf(() => s.catalog.publish(req));
    expect([e.code, e.data]).toEqual(['invalid_request', { field: 'files[1].sha256', why: 'not_uploaded' }]);
    expect(s.commits).toEqual([]);
    expect((await errorOf(() => s.local.fetch({ name: 'half', version: 1 }))).code).toBe('not_found');
  });

  it('a sha256 that is not 64 lowercase hex characters can never have been uploaded: not_uploaded', async () => {
    const s = await standIn();
    for (const bad of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) {
      const e = await errorOf(() => s.catalog.publish({ name: 'odd', files: [{ path: 'SKILL.md', mode: '0644', sha256: bad }] }));
      expect([bad, e.code, e.data]).toEqual([bad, 'invalid_request', { field: 'files[0].sha256', why: 'not_uploaded' }]);
    }
    const long = await errorOf(() => s.catalog.publish({ name: 'odd', files: [{ path: 'SKILL.md', mode: '0644', sha256: 'a'.repeat(65) }] }));
    expect([long.code, (long.data as { field: string }).field]).toEqual(['invalid_request', 'files[0].sha256']);
  });

  it('a file gone by the commit (swept between the read and the commit) is not_uploaded too, never a bug', async () => {
    const s = await standIn({ sweptBeforeCommit: [sha256Of('Swept.\n')] });
    const req = uploaded(s, 'raced', [
      { path: 'SKILL.md', text: skillMd('raced') },
      { path: 'gone.md', text: 'Swept.\n' },
    ]);
    const e = await errorOf(() => s.catalog.publish(req));
    expect([e.code, e.data]).toEqual(['invalid_request', { field: 'files[1].sha256', why: 'not_uploaded' }]);
    expect(s.commits).toHaveLength(1);
    expect((await errorOf(() => s.local.fetch({ name: 'raced', version: 1 }))).code).toBe('not_found');
  });

  it('the refusal order holds: not_owner and conflict come before a file not uploaded', async () => {
    const s = await standIn();
    await s.local.publish({ name: 'taken', files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('taken')) }] }, actAs('erin'));
    const never = [{ path: 'SKILL.md', mode: '0644', sha256: sha256Of('never sent') }];
    expect((await errorOf(() => s.catalog.publish({ name: 'taken', files: never }))).code).toBe('not_owner');
    expect((await errorOf(() => s.catalog.publish({ name: 'mine', files: never, expected_latest: 3 }))).code).toBe('conflict');
  });

  it('the same checks run on the uploaded bytes: manifest, paths, secrets, sizes', async () => {
    const s = await standIn({ config: { limits: { files: 10, file_bytes: 100, skill_bytes: 150 } } });
    const noManifest = await errorOf(() => s.catalog.publish(uploaded(s, 'nomd', [{ path: 'README.md', text: 'Hi.\n' }])));
    expect(noManifest.code).toBe('invalid_manifest');
    const badPath = await errorOf(() => s.catalog.publish(uploaded(s, 'badpath', [{ path: 'SKILL.md', text: skillMd('badpath') }, { path: '.git/x', text: 'x' }])));
    expect(badPath.code).toBe('invalid_path');
    const secret = await errorOf(() => s.catalog.publish(uploaded(s, 'leaky', [{ path: 'SKILL.md', text: skillMd('leaky', 'key AKIAIOSFODNN7EXAMPLE\n') }])));
    expect(secret.code).toBe('secret_suspected');
    const big = await errorOf(() => s.catalog.publish(uploaded(s, 'big', [{ path: 'SKILL.md', text: skillMd('big', 'x'.repeat(120)) }])));
    expect([big.code, (big.data as { limit: string }).limit]).toEqual(['too_large', 'file_bytes']);
    expect(s.commits).toEqual([]);
  });

  it('a dry run in the sha256 form checks everything and commits nothing', async () => {
    const s = await standIn();
    const r = await s.catalog.publish(uploaded(s, 'dry', [{ path: 'SKILL.md', text: skillMd('dry') }], { dry_run: true }));
    expect([r.dry_run, r.created, r.version]).toEqual([true, false, 1]);
    expect(s.commits).toEqual([]);
  });

  it('publishing the same files again is unchanged', async () => {
    const s = await standIn();
    const files = [{ path: 'SKILL.md', text: skillMd('again') }];
    await s.catalog.publish(uploaded(s, 'again', files));
    const r = await s.catalog.publish(uploaded(s, 'again', files));
    expect([r.version, r.created]).toEqual([1, false]);
  });
});

describe('request_upload_links, hosted only', () => {
  const ask = (files: { sha256: string; size: number }[], name = 'fresh') => ({ name, files });

  it('is a hosted-only web operation that writes the catalog (its claims), in the hosted schema and not the local one', () => {
    const def = OPERATIONS['request_upload_links']!;
    expect([def.where, def.faces, def.effect, def.kind]).toEqual(['hosted', ['web'], 'writes_catalog', 'catalog']);
    expect((inputSchema(def, 'web', 'hosted').properties['files'] as { maxItems?: number }).maxItems).toBe(100);
    expect(Object.keys((openapi('local') as any).paths)).not.toContain('/api/v1/request_upload_links');
    expect(Object.keys((openapi('hosted') as any).paths)).toContain('/api/v1/request_upload_links');
  });

  it('answers each file: a link for one not stored, "stored" for one that is (claimed by the port), "removing" with when to try again', async () => {
    const gone = sha256Of('being removed');
    const s = await standIn({ removing: { [gone]: '2026-09-28T13:00:00.000Z' } });
    const have = s.upload('already here');
    const want = sha256Of('new bytes');
    const r = await s.catalog.uploadLinks(ask([
      { sha256: want, size: 9 },
      { sha256: have, size: 12 },
      { sha256: gone, size: 13 },
    ]));
    expect(r).toEqual({
      name: 'fresh',
      files: [
        { sha256: want, kind: 'upload', url: `https://uploads.test/${want}`, headers: { 'if-none-match': '*' } },
        { sha256: have, kind: 'stored' },
        { sha256: gone, kind: 'removing', retry_after: '2026-09-28T13:00:00.000Z' },
      ],
    });
    expect(s.linkCalls).toEqual([[{ sha256: want, size: 9 }, { sha256: have, size: 12 }, { sha256: gone, size: 13 }]]);
  });

  it('checks who is asking, the name and the sizes before any link is made', async () => {
    const one = [{ sha256: sha256Of('x'), size: 1 }];
    const nobody = await standIn({ identity: actAs(undefined) });
    expect((await errorOf(() => nobody.catalog.uploadLinks(ask(one)))).code).toBe('unauthenticated');
    expect(nobody.linkCalls).toEqual([]);

    const s = await standIn({ config: { limits: { files: 10, file_bytes: 100, skill_bytes: 150 } } });
    await s.local.publish({ name: 'erins', files: [{ path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('erins')) }] }, actAs('erin'));
    expect((await errorOf(() => s.catalog.uploadLinks(ask(one, 'erins')))).code).toBe('not_owner');
    expect((await errorOf(() => s.catalog.uploadLinks(ask(one, 'Not A Name')))).code).toBe('invalid_name');
    const file = await errorOf(() => s.catalog.uploadLinks(ask([{ sha256: sha256Of('a'), size: 101 }])));
    expect([file.code, file.data]).toMatchObject(['too_large', { limit: 'file_bytes', max: 100, value: 101 }]);
    const total = await errorOf(() => s.catalog.uploadLinks(ask([{ sha256: sha256Of('a'), size: 100 }, { sha256: sha256Of('b'), size: 51 }])));
    expect([total.code, total.data]).toMatchObject(['too_large', { limit: 'skill_bytes', max: 150, value: 151 }]);
    const many = await errorOf(() => s.catalog.uploadLinks(ask(Array.from({ length: 101 }, (_, i) => ({ sha256: sha256Of(String(i)), size: 1 })))));
    expect([many.code, many.data]).toMatchObject(['invalid_request', { field: 'files', why: 'too_many', limit: 100 }]);
    const odd = await errorOf(() => s.catalog.uploadLinks(ask([{ sha256: 'A'.repeat(64), size: 1 }])));
    expect([odd.code, (odd.data as { field: string }).field]).toEqual(['invalid_request', 'files[0].sha256']);
    expect(s.linkCalls).toEqual([]);
  });

  it('a new name, or one the asker owns, gets its links', async () => {
    const s = await standIn();
    await s.catalog.publish(uploaded(s, 'owned', [{ path: 'SKILL.md', text: skillMd('owned') }]));
    for (const name of ['owned', 'brand-new']) expect((await s.catalog.uploadLinks(ask([{ sha256: sha256Of(name), size: 3 }], name))).files[0]!.kind).toBe('upload');
  });

  it('a local catalog has no such operation', async () => {
    const { catalog } = await openTest({ identity: actAs('dana') });
    await expect(catalog.uploadLinks(ask([{ sha256: sha256Of('x'), size: 1 }]))).rejects.toThrow(/hosted only/);
    catalog.close();
  });
});

describe('fetch_version, hosted: links from the version it reads', () => {
  it('names each file by its sha256 and size with a download link, reading no file\'s bytes', async () => {
    const s = await standIn();
    const files = [
      { path: 'SKILL.md', text: skillMd('fetched') },
      { path: 'run.sh', text: '#!/bin/sh\necho hi\n', mode: '0755' },
    ];
    const p = await s.catalog.publish(uploaded(s, 'fetched', files));
    s.blobReads.length = 0;
    const r = await s.catalog.fetch({ name: 'fetched', version: 1 });
    expect(r).toEqual({
      name: 'fetched',
      version: 1,
      fingerprint: p.fingerprint,
      files: files.map((f) => ({ path: f.path, mode: f.mode ?? '0644', sha256: sha256Of(f.text), size: Buffer.byteLength(f.text), url: `https://files.test/${sha256Of(f.text)}` })),
    });
    expect(s.blobReads).toEqual([]);
  });

  it('the hosted schema describes the hosted answer, and the local one the inline answer', () => {
    const files = (where: 'local' | 'hosted') => Object.keys((openapi(where) as any).components.schemas.fetch_version_output.properties.files.items.properties);
    expect(files('local')).toEqual(['path', 'mode', 'content_base64']);
    expect(files('hosted')).toEqual(['path', 'mode', 'sha256', 'size', 'url']);
  });
});
