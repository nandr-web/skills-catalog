// The hosted client (core's openRemoteCatalog) against the hosted API's own handler, on a hosted catalog on the AWS
// stand-in: every operation goes over the web API with a Bearer token, files go up and come back through real links
// (moto's), and what comes back is what the local catalog would answer: the same bytes, the same refusals.

import { createHash } from 'node:crypto';
import { CatalogError, Words, openCatalog, type Catalog } from '@skills-catalog/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostedHandler } from '../src/api/handler.ts';
import type { TokenHolder } from '../src/index.ts';
import { hostedAdapter } from './adapter.ts';
import { startEmulator, type Emulator } from './emulator.ts';

const CATALOG = 'https://catalog.test';
const HOLDERS: Record<string, TokenHolder> = {
  't-ana': { owner: 'ana', scope: 'publish', kind: 'session' },
  't-bob': { owner: 'bob', scope: 'publish', kind: 'session' },
  't-reader': { owner: 'rae', scope: 'read', kind: 'session' },
};
const b64 = (s: string) => Buffer.from(s).toString('base64');
const skillMd = (name: string, description: string, body = 'List the merged pull requests and fill template.md.\n') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
const V1 = [
  { path: 'SKILL.md', mode: '0644', content_base64: b64(skillMd('release-note-draft', 'Write release notes and a changelog from merged pull requests.')) },
  { path: 'template.md', mode: '0644', content_base64: b64('# Release notes\n') },
];
const V2 = [...V1, { path: 'scripts/collect.sh', mode: '0755', content_base64: b64('#!/bin/sh\ngit log --merges --oneline\n') }];

let emu: Emulator | undefined;
let catalog: Catalog | undefined;
let handler: ReturnType<typeof createHostedHandler> | undefined;
const apiCalls: string[] = [];

/** The client's HTTP: the catalog's address goes to the hosted handler in process; a link (moto's) over the network. */
const http: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== CATALOG) return fetch(input, init);
  apiCalls.push(url.pathname);
  const headers = Object.fromEntries(new Headers(init?.headers).entries());
  const body = init?.body ? new TextEncoder().encode(String(init.body)) : new Uint8Array();
  const r = await handler!.handle({ method: init?.method ?? 'GET', path: url.pathname, headers, body });
  return new Response(r.status === 302 ? null : (r.body as BodyInit), { status: r.status, headers: r.headers });
};
const as = (token: string | undefined) => openCatalog(CATALOG, { token, fetch: http });
const errorOf = async (p: Promise<unknown>) => p.then(() => undefined, (e) => e as CatalogError);

beforeAll(async () => {
  emu = await startEmulator();
  // The shared suites' caller follows links and uploads for them; the handler here sits on the hosted catalog itself
  // (the caller's prototype), so only the client under test does that work.
  catalog = Object.getPrototypeOf(await hostedAdapter(() => emu!.endpoint).store().open()) as Catalog;
  handler = createHostedHandler({ catalog, tokens: { verify: async (t) => HOLDERS[t] }, words: Words.load(), origin: { allows: async () => true } });
}, 30_000);
afterAll(async () => {
  catalog?.close();
  await emu?.stop();
});

describe('the hosted client', () => {
  it('publishes through upload links (never bytes in a request), then finds, reads, lists and diffs as another person', async () => {
    const ana = await as('t-ana');
    const r1 = await ana.publish({ name: 'release-note-draft', files: V1, message: 'first version' }, undefined as never, 'mcp');
    expect(r1).toMatchObject({ name: 'release-note-draft', version: 1, created: true });
    expect(apiCalls).toContain('/api/v1/request_upload_links');
    const r2 = await ana.publish({ name: 'release-note-draft', files: V2 }, undefined as never, 'mcp');
    expect(r2).toMatchObject({ version: 2 });
    expect(r2.risk_flags.map((f) => f.kind)).toContain('runnable_file');

    const bob = await as('t-bob');
    const found = await bob.search({ query: 'changelog release' }, 'mcp');
    expect(found.results.map((s) => s.name)).toEqual(['release-note-draft']);
    const read = await bob.read({ name: 'release-note-draft' }, 'mcp');
    expect(JSON.stringify(read)).toContain('Write release notes');
    const versions = await bob.versions({ name: 'release-note-draft' }, 'mcp');
    expect(versions.versions.map((v) => v.version)).toEqual([2, 1]);
    const diff = await bob.diff({ name: 'release-note-draft', from: 1, to: 2 }, 'mcp');
    expect(diff.files.map((f) => f.path)).toEqual(['scripts/collect.sh']);
  });

  it('fetches a version back as its bytes, downloaded through its links, matching its fingerprint', async () => {
    const bob = await as('t-bob');
    const r = await bob.fetch({ name: 'release-note-draft', version: 2 }, 'mcp');
    const sorted = [...r.files].sort((a, b) => a.path.localeCompare(b.path));
    expect(sorted).toEqual([...V2].sort((a, b) => a.path.localeCompare(b.path)));
    const listed = (await bob.versions({ name: 'release-note-draft' }, 'mcp')).versions.find((v) => v.version === 2)!;
    expect(r.fingerprint).toBe(listed.fingerprint);
  });

  it("refuses bob's publish over ana's skill, with the catalog's own error", async () => {
    const e = await errorOf((await as('t-bob')).publish({ name: 'release-note-draft', files: V1 }, undefined as never, 'mcp'));
    expect(e).toBeInstanceOf(CatalogError);
    expect(e!.code).toBe('not_owner');
  });

  it('without a token every call is unauthenticated; a read-only token may not publish', async () => {
    expect((await errorOf((await as(undefined)).search({ query: 'x' }, 'mcp')))!.code).toBe('unauthenticated');
    expect((await errorOf((await as('t-nobody')).search({ query: 'x' }, 'mcp')))!.code).toBe('unauthenticated');
    const e = await errorOf((await as('t-reader')).publish({ name: 'readers-skill', files: V1 }, undefined as never, 'mcp'));
    expect(e).toBeInstanceOf(CatalogError);
  });

  it("a file's address answers its link", async () => {
    const sha = createHash('sha256').update(Buffer.from(V1[1]!.content_base64, 'base64')).digest('hex');
    const a = await (await as('t-bob')).file(sha);
    expect(a.kind).toBe('link');
  });
});
