// A stored version's file by its sha256 (contract §1.1, the files route): served only when some stored version names
// it; the bytes checked on the way out; a link instead of the bytes where a BlobLinks port is wired (hosted); on its
// way while a hosted publish's lookup catches up; unknown otherwise, and for anything that isn't 64 lowercase hex.
import { describe, expect, it } from 'vitest';
import { Catalog, type FileAnswer } from '../src/catalog.ts';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import type { BlobLinks, Storage } from '../src/ports.ts';
import { sha256Hex } from '../src/skill-tree/index.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { fixedClock, counterIds, openTest, request } from './helpers.ts';

const histories = loadGolden('histories.yaml');
const NAME = 'pr-review-checklist';
const files = (v: string) => historyVersion(histories.versions[v]);

async function published(opts = {}) {
  const opened = await openTest(opts);
  for (const v of ['prc.v1', 'prc.v2']) await opened.catalog.publish(request(NAME, files(v)), actAs('dev1'));
  return opened;
}

// An answer with its bytes as a Buffer, so bytes compare by content whatever array type storage gave.
const seen = (a: FileAnswer) => (a.kind === 'bytes' ? { ...a, bytes: Buffer.from(a.bytes) } : a);

// Counts what file() asks storage, so a malformed sha256 can be shown to ask nothing.
function counting(asked: string[]) {
  return (s: Storage): Storage =>
    new Proxy(s, {
      get: (t, prop, recv) => {
        const v = Reflect.get(t, prop, recv);
        return typeof v === 'function' && (prop === 'fileState' || prop === 'blob') ? (...a: unknown[]) => (asked.push(String(prop)), v.apply(t, a)) : v;
      },
    });
}

describe('Catalog.file: a stored version\'s file by its sha256', () => {
  it('gives the bytes of every file a stored version names, old versions too', async () => {
    const { catalog } = await published();
    for (const v of ['prc.v1', 'prc.v2']) {
      for (const f of files(v)) {
        const got = seen(await catalog.file(sha256Hex(f.bytes)));
        expect([f.path, got]).toEqual([f.path, { kind: 'bytes', bytes: Buffer.from(f.bytes) }]);
      }
    }
    catalog.close();
  });

  it('is unknown for a sha256 no version names, even when storage holds those bytes', async () => {
    const orphan = new TextEncoder().encode('bytes a refused publish left behind\n');
    const { catalog } = await published({ wrapBlobs: (b: any) => (b.put(sha256Hex(orphan), orphan), b) });
    expect(await catalog.file(sha256Hex(orphan))).toEqual({ kind: 'unknown' });
    expect(await catalog.file('0'.repeat(64))).toEqual({ kind: 'unknown' });
    catalog.close();
  });

  it('is unknown for a sha256 that a version only mentions (in a file\'s path), not names as a file', async () => {
    const orphan = new TextEncoder().encode('stored, but no version\'s file\n');
    const sha = sha256Hex(orphan);
    const { catalog } = await published({ wrapBlobs: (b: any) => (b.put(sha, orphan), b) });
    const mention = [...files('prc.v2'), { path: `notes/${sha}.md`, mode: '0644', bytes: new TextEncoder().encode('A note.\n') }];
    await catalog.publish(request(NAME, mention as any), actAs('dev1'));
    expect(await catalog.file(sha)).toEqual({ kind: 'unknown' });
    catalog.close();
  });

  it('is unknown, asking storage nothing, for anything but 64 lowercase hex', async () => {
    const asked: string[] = [];
    const { catalog } = await published({ wrapStorage: counting(asked) });
    const real = sha256Hex(files('prc.v1')[0]!.bytes);
    asked.length = 0;
    for (const bad of [real.toUpperCase(), real.slice(1), `${real}0`, `sha256:${real}`, `${real.slice(0, 63)}g`, '', '../' + real.slice(3), 'constructor']) {
      expect([bad, await catalog.file(bad)]).toEqual([bad, { kind: 'unknown' }]);
    }
    expect(asked).toEqual([]);
    catalog.close();
  });

  it('works on the read-only open', async () => {
    const { dir, catalog } = await published();
    catalog.close();
    const ro = await openLocalCatalog(`${dir}/catalog`, { readOnly: true });
    const f = files('prc.v2')[0]!;
    expect(seen(await ro.file(sha256Hex(f.bytes)))).toEqual({ kind: 'bytes', bytes: Buffer.from(f.bytes) });
    expect(await ro.file('f'.repeat(64))).toEqual({ kind: 'unknown' });
    ro.close();
  });

  it('local storage names a file or doesn\'t know it: never on its way', async () => {
    const { catalog } = await published();
    const storage = (catalog as unknown as { p: { storage: Storage } }).p.storage;
    expect(await storage.fileState(sha256Hex(files('prc.v1')[0]!.bytes))).toBe('named');
    expect(await storage.fileState('0'.repeat(64))).toBe('unknown');
    catalog.close();
  });
});

describe('Catalog.file where storage or a link port answers otherwise (hosted)', () => {
  const sha = 'a'.repeat(64);
  const bytes = new TextEncoder().encode('x');
  const ports = (state: 'named' | 'on_its_way' | 'unknown', links?: BlobLinks) => ({
    storage: { fileState: async () => state, blob: async () => bytes } as unknown as Storage,
    index: {} as never,
    events: { subscribe: () => {}, deliver: async () => 0 },
    identity: actAs(undefined),
    clock: fixedClock(),
    ids: counterIds(),
    ...(links ? { links } : {}),
  });
  const open = (state: 'named' | 'on_its_way' | 'unknown', links?: BlobLinks) => Catalog.open(ports(state, links));

  it('a named file is a link when a BlobLinks port is wired, and its bytes are never read', async () => {
    const asked: string[] = [];
    const links: BlobLinks = { downloadLink: async (s) => (asked.push(s), `https://files.example.invalid/${s}?signed`) };
    const c = await open('named', links);
    expect(await c.file(sha)).toEqual({ kind: 'link', url: `https://files.example.invalid/${sha}?signed` });
    expect(asked).toEqual([sha]);
  });

  it('refuses bytes that don\'t match their sha256, as a fetch does', async () => {
    const c = await Catalog.open({ ...ports('named'), storage: { fileState: async () => 'named', blob: async () => new TextEncoder().encode('Altered.\n') } as unknown as Storage });
    await expect(c.file(sha)).rejects.toThrow(/does not match its sha256/);
  });

  it('on its way is passed through, with no link and no bytes', async () => {
    const links: BlobLinks = { downloadLink: async () => { throw new Error('no link for a file on its way'); } };
    expect(await (await open('on_its_way', links)).file(sha)).toEqual({ kind: 'on_its_way' });
    expect(await (await open('unknown', links)).file(sha)).toEqual({ kind: 'unknown' });
  });
});
