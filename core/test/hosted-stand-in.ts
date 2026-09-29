// A hosted catalog in process, for the core's own tests of the hosted forms (contract §1.1): the local storage behind
// a hosted catalog, with uploads held apart until a commit names them, as S3 holds a file put through a link. Its
// commit takes files by sha256 alone (bytes given to it are a bug here, as they are hosted); a commit names a file
// if it's stored or was uploaded. The hosted adapters' own suite runs the same forms on the AWS stand-in.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Catalog, type CatalogConfig } from '../src/catalog.ts';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import { memorySearchIndex } from '../src/local/search-index.ts';
import type { BlobLinks, GitHubSignIn, Identity, Storage, TokenHolder, TokenInfo, TokenStore, UploadAnswer } from '../src/ports.ts';
import { counterIds, fixedClock } from './helpers.ts';
import { sandbox } from './sandbox.ts';

export const sha256Of = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Tokens in memory, as the hosted store keeps them (hashed there; here the test reads them back). */
export class MemoryTokens implements TokenStore {
  readonly byToken = new Map<string, TokenInfo>();
  private n = 0;
  constructor(private readonly clock: { now(): Date }) {}
  async issue(t: TokenHolder & { expiresAt: Date }) {
    const id = `id${String(++this.n).padStart(14, '0')}`;
    const token = `tok-${id}`;
    this.byToken.set(token, { id, owner: t.owner, scope: t.scope, kind: t.kind, created_at: this.clock.now().toISOString(), expires_at: t.expiresAt.toISOString() });
    return { id, token };
  }
  async verify(token: string) {
    const t = this.byToken.get(token);
    if (!t || t.revoked_at || !(Date.parse(t.expires_at) > this.clock.now().getTime())) return undefined;
    return { owner: t.owner, scope: t.scope, kind: t.kind };
  }
  async list(owner: string) {
    return [...this.byToken.values()].filter((t) => t.owner === owner).map((t) => ({ ...t }));
  }
  async revoke(owner: string, id: string) {
    const t = [...this.byToken.values()].find((x) => x.owner === owner && x.id === id);
    if (!t) return false;
    t.revoked_at ??= this.clock.now().toISOString();
    return true;
  }
}

export interface StandIn {
  catalog: Catalog;
  tokens: MemoryTokens;
  /** The GitHub tokens the sign-in port was asked about. */
  githubCalls: string[];
  /** Put a file as a link would (its bytes, held until a commit names them). */
  upload(bytes: Uint8Array | string): string;
  /** Forget an upload, as the sweep would between a publish's read and its commit. */
  drop(sha256: string): void;
  /** What the links port was asked, call by call. */
  linkCalls: { sha256: string; size: number }[][];
  /** The files a commit was given, commit by commit. */
  commits: { sha256: string; bytes?: Uint8Array | undefined }[][];
  /** The storage's blob reads, by sha256. */
  blobReads: string[];
  /** A local catalog on the same storage (to publish a skill the ordinary way, or read what's stored). */
  local: Catalog;
  close(): void;
}

export interface StandInOptions {
  identity?: Identity;
  config?: Partial<CatalogConfig>;
  /** Files the links port answers as being removed, with when to try again. */
  removing?: Record<string, string>;
  /** Files whose stored bytes aren't the ones their name hashes (as a body S3 took unchecked would be). */
  altered?: Record<string, string>;
  /** Uploads the sweep takes away after the publish reads them and before its commit looks. */
  sweptBeforeCommit?: string[];
  /** What GitHub says of a token: our app's for this login, another app's or revoked (undefined), or unreachable. */
  github?: (githubToken: string) => string | undefined | 'down';
}

export async function openHostedStandIn(opts: StandInOptions = {}): Promise<StandIn> {
  let inner: Storage | undefined;
  const local = await openLocalCatalog(join(sandbox(), 'catalog'), {
    clock: fixedClock(),
    ids: counterIds(),
    ...(opts.config ? { config: opts.config } : {}),
    wrapStorage: (s) => (inner = s),
  });
  const storage = inner!;
  const uploads = new Map<string, Uint8Array>();
  const linkCalls: StandIn['linkCalls'] = [];
  const commits: StandIn['commits'] = [];
  const blobReads: string[] = [];
  const stored = async (sha: string) => uploads.has(sha) || (await storage.blob(sha)) !== undefined;

  const hosted: Storage = Object.assign(Object.create(storage), {
    blob: async (sha: string) => {
      blobReads.push(sha);
      const altered = opts.altered?.[sha];
      if (altered !== undefined) return Buffer.from(altered);
      return uploads.get(sha) ?? storage.blob(sha);
    },
    commit: async (...[v, files, cond, event]: Parameters<Storage['commit']>) => {
      commits.push(files.map((f) => ({ ...f })));
      for (const sha of opts.sweptBeforeCommit ?? []) uploads.delete(sha);
      if (files.some((f) => f.bytes !== undefined)) throw new Error('a hosted commit takes files by sha256 alone');
      return storage.commit(v, files.map((f) => ({ sha256: f.sha256, bytes: uploads.get(f.sha256) })), cond, event);
    },
  });
  const links: BlobLinks = {
    async uploadLinks(files) {
      linkCalls.push(files.map((f) => ({ ...f })));
      const out: UploadAnswer[] = [];
      for (const f of files) {
        const removing = opts.removing?.[f.sha256];
        if (removing !== undefined) out.push({ kind: 'removing', sha256: f.sha256, retry_after: removing });
        else if (await stored(f.sha256)) out.push({ kind: 'stored', sha256: f.sha256 });
        else out.push({ kind: 'upload', sha256: f.sha256, url: `https://uploads.test/${f.sha256}`, headers: { 'if-none-match': '*' } });
      }
      return out;
    },
    downloadLink: async (sha) => `https://files.test/${sha}`,
  };
  const index = memorySearchIndex();
  const clock = fixedClock();
  const tokens = new MemoryTokens(clock);
  const githubCalls: string[] = [];
  const signIn: GitHubSignIn = {
    async login(githubToken) {
      githubCalls.push(githubToken);
      const said = opts.github?.(githubToken);
      if (said === 'down') throw new Error('GitHub answered 502');
      return said;
    },
  };
  const catalog = await Catalog.open({
    where: 'hosted',
    links,
    tokens,
    signIn,
    storage: hosted,
    index,
    events: { subscribe: () => {}, deliver: async () => 0 },
    identity: opts.identity ?? actAs('dana'),
    clock,
    ids: counterIds(),
    ...(opts.config ? { config: opts.config } : {}),
    close: () => index.close(),
  });
  return {
    catalog,
    tokens,
    githubCalls,
    local,
    upload(bytes) {
      const b = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
      const sha = sha256Of(b);
      uploads.set(sha, b);
      return sha;
    },
    drop: (sha) => void uploads.delete(sha),
    linkCalls,
    commits,
    blobReads,
    close() {
      catalog.close();
      local.close();
    },
  };
}
