// A hosted catalog, from this machine (contract §1.1, §8): SKILLS_CATALOG=https://… The Catalog's operations as the web
// API serves them (POST /api/v1/<operation>, the envelope back), with the person's Bearer token. Who acts is the
// token's holder, never said here. Two operations take files by link, as a hosted caller does: a publish puts each
// file through an upload link first and then names it by sha256; a fetch downloads each file from its link and hands
// back the inline form, so the installer checks the bytes against the version's fingerprint as it does locally.

import { createHash } from 'node:crypto';
import { MAX_UPLOAD_LINKS, OPERATIONS } from '../api.ts';
import type { Catalog, FileAnswer } from '../catalog.ts';
import { CatalogError } from '../errors.ts';
import { checkManifest, checkName, checkTree, scanSecrets } from '../skill-tree/index.ts';

export type RemoteOptions = {
  /** The catalog's Bearer token (skills-catalog login saves one); without it every call is unauthenticated. */
  token?: string | undefined;
  /** The HTTP client (tests route it to a handler in process). */
  fetch?: typeof fetch;
};

type Inline = { path: string; mode: string; content_base64: string };
const NO_LIMITS = { files: Infinity, file_bytes: Infinity, skill_bytes: Infinity };
/** The refusals a publish makes before it looks at the files (contract §5.1). */
const BEFORE_FILES = new Set(['unauthenticated', 'forbidden', 'not_owner', 'conflict']);
const API = '/api/v1/';

export function openRemoteCatalog(url: string, o: RemoteOptions = {}): Catalog {
  const base = url.replace(/\/+$/, '');
  const http = o.fetch ?? fetch;
  const auth: Record<string, string> = o.token ? { authorization: `Bearer ${o.token}` } : {};

  async function call(op: string, input: unknown): Promise<any> {
    let res: Response;
    try {
      res = await http(`${base}${API}${op}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(input ?? {}) });
    } catch (e) {
      // The network or the address, not a bug: its own code, so the person is told what to check (review V4.3).
      throw new CatalogError('catalog_unreachable', { catalog: base, detail: e instanceof Error ? e.message : String(e) });
    }
    let body: any;
    try {
      body = await res.json();
    } catch {
      throw new Error(`the catalog at ${base} answered ${res.status} without its envelope`);
    }
    if (body?.ok === true) return body.data;
    if (body?.ok === false && body.error && typeof body.error.code === 'string') {
      const { code, ...data } = body.error;
      throw new CatalogError(code, data);
    }
    throw new Error(`the catalog at ${base} answered ${res.status} without its envelope`);
  }

  const proxy: Record<string, unknown> = {};
  for (const [op, row] of Object.entries(OPERATIONS)) {
    if (row.kind !== 'catalog' || !row.faces.includes('web')) continue;
    // A method that acts takes (input, identity, face) and one that doesn't (input, face): only the input goes; the
    // token says who acts.
    proxy[row.run] = (input: unknown) => call(op, input);
  }

  proxy['publish'] = async (input: { name: string; files?: Inline[]; allow_suspected_secrets?: boolean } & Record<string, unknown>) => {
    // The override is the person's, on the CLI of a local catalog only: a hosted catalog never takes it.
    const { allow_suspected_secrets: _, ...rest } = input;
    if (!Array.isArray(rest.files)) return call('publish_version', rest);
    const files = rest.files.map((f) => {
      const bytes = Buffer.from(f.content_base64, 'base64');
      return { path: f.path, mode: f.mode, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
    });
    // The checks a publish can make on this machine, before any file goes up (review P5.6): the paths, SKILL.md and the
    // secret scan, as the catalog makes them (a hosted catalog never takes the override). A refused publish, or its
    // preview's dry run, then leaves nothing in the catalog's storage. The sizes are the catalog's to check: its limits
    // can differ from the defaults, and request_upload_links checks them before giving a link.
    try {
      const tree = checkTree(files, NO_LIMITS);
      checkManifest(tree, checkName(rest.name));
      const secret = scanSecrets(tree);
      if (secret) throw new CatalogError('secret_suspected', { ...secret });
    } catch (e) {
      // One order of refusals (contract §5.1): the token, the owner and the latest come before the files. So a local
      // refusal first asks the catalog, with no file uploaded: a dry run naming SKILL.md by a sha256 never uploaded is
      // refused for whichever comes first, and anything that isn't one of those (not_uploaded, the files) leaves the
      // local refusal standing.
      if (!(e instanceof CatalogError)) throw e;
      const md = files.find((f) => f.path === 'SKILL.md') ?? files[0];
      const probe = { name: rest.name, dry_run: true, files: md ? [{ path: md.path, mode: md.mode, sha256: md.sha256 }] : [], ...(rest.expected_latest !== undefined ? { expected_latest: rest.expected_latest } : {}) };
      try {
        await call('publish_version', probe);
      } catch (first) {
        if (first instanceof CatalogError && BEFORE_FILES.has(first.code)) throw first;
      }
      throw e;
    }
    const distinct = [...new Map(files.map((f) => [f.sha256, f.bytes])).entries()];
    for (let at = 0; at < distinct.length; at += MAX_UPLOAD_LINKS) {
      const batch = distinct.slice(at, at + MAX_UPLOAD_LINKS);
      const links = await call('request_upload_links', { name: rest.name, files: batch.map(([sha256, bytes]) => ({ sha256, size: bytes.length })) });
      for (const a of links.files as { kind: string; sha256: string; url?: string; headers?: Record<string, string>; retry_after?: string }[]) {
        if (a.kind === 'removing') throw new CatalogError('conflict', { name: rest.name, retry_after: a.retry_after });
        if (a.kind !== 'upload') continue;
        const bytes = distinct.find(([sha]) => sha === a.sha256)?.[1];
        if (!bytes) throw new Error(`the catalog gave a link for a file not asked about (${a.sha256})`);
        const put = await http(a.url!, { method: 'PUT', body: bytes, headers: a.headers ?? {} });
        // 412: the same file was put by another publish in between (put-if-absent); the commit checks its bytes anyway.
        if (!put.ok && put.status !== 412) throw new Error(`uploading ${a.sha256} answered ${put.status}`);
      }
    }
    return call('publish_version', { ...rest, files: files.map(({ path, mode, sha256 }) => ({ path, mode, sha256 })) });
  };

  proxy['fetch'] = async (input: unknown) => {
    const r = await call('fetch_version', input);
    const files: Inline[] = await Promise.all(
      (r.files as ({ path: string; mode: string; url: string; sha256: string } | Inline)[]).map(async (f) => {
        if (!('url' in f)) return f;
        const got = await http(f.url);
        if (!got.ok) throw new Error(`downloading ${f.sha256} answered ${got.status}`);
        return { path: f.path, mode: f.mode, content_base64: Buffer.from(await got.arrayBuffer()).toString('base64') };
      }),
    );
    return { ...r, files };
  };

  proxy['file'] = async (sha256: string): Promise<FileAnswer> => {
    const res = await http(`${base}${API}files/${sha256}`, { headers: auth, redirect: 'manual' });
    if (res.status === 302 && res.headers.get('location')) return { kind: 'link', url: res.headers.get('location')! };
    if (res.status === 200) return { kind: 'bytes', bytes: new Uint8Array(await res.arrayBuffer()) };
    if (res.status === 503) return { kind: 'on_its_way' };
    return { kind: 'unknown' };
  };

  Object.defineProperty(proxy, 'where', { value: 'hosted', enumerable: true });
  proxy['close'] = () => {};
  return proxy as unknown as Catalog;
}
