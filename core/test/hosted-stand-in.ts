// A hosted catalog in process, for the core's own tests of the hosted forms (contract §1.1): the local storage behind
// a hosted catalog, with uploads held apart until a commit names them, as S3 holds a file put through a link. Its
// commit takes files by sha256 alone (bytes given to it are a bug here, as they are hosted); a commit names a file
// if it's stored or was uploaded. The hosted adapters' own suite runs the same forms on the AWS stand-in.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Catalog, type CatalogConfig } from '../src/catalog.ts';
import { actAs, openLocalCatalog } from '../src/local/index.ts';
import { memorySearchIndex } from '../src/local/search-index.ts';
import type { BlobLinks, GitHubSignIn, Identity, Storage, TokenHolder, TokenInfo, TokenScope, TokenStore, UploadAnswer } from '../src/ports.ts';
import { counterIds, fixedClock } from './helpers.ts';
import { sandbox } from './sandbox.ts';

export const sha256Of = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

/** Tokens in memory, as the hosted store keeps them (hashed there; here the test reads them back). */
export class MemoryTokens implements TokenStore {
  readonly byToken = new Map<string, TokenInfo>();
  /** GitHub's id recorded for each login at its first sign-in. */
  readonly bindings = new Map<string, number>();
  /** Every call that could write: issue, bindLogin, revoke, in order. */
  readonly calls: string[] = [];
  private n = 0;
  private readonly clock: { now(): Date };
  constructor(clock: { now(): Date }) {
    this.clock = clock;
  }
  async issue(t: TokenHolder & { expiresAt: Date }) {
    this.calls.push(`issue ${t.owner}`);
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
  async liveCount(owner: string) {
    const now = this.clock.now().getTime();
    return [...this.byToken.values()].filter((t) => t.owner === owner && !t.revoked_at && Date.parse(t.expires_at) > now).length;
  }
  async bindLogin(login: string, githubId: number) {
    this.calls.push(`bindLogin ${login} ${githubId}`);
    const bound = this.bindings.get(login);
    if (bound === undefined) this.bindings.set(login, githubId);
    return bound === undefined || bound === githubId;
  }
  async revoke(owner: string, id: string, upTo: TokenScope) {
    this.calls.push(`revoke ${owner} ${id} ${upTo}`);
    const t = [...this.byToken.values()].find((x) => x.owner === owner && x.id === id);
    if (!t) return 'none' as const;
    if (t.scope === 'publish' && upTo === 'read') return 'above' as const;
    t.revoked_at ??= this.clock.now().toISOString();
    return 'revoked' as const;
  }
}

/** Acting as a holder of a hosted token of this scope. */
export const holding = (owner: string, scope: TokenScope): Identity => ({ actor: async () => owner, scope: async () => scope });

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
  /** Every other storage lookup, by method: skill, version, fileState, … */
  lookups: string[];
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
  /** What GitHub says of a token: our app's for this login (GitHub's id 1 unless given), another app's or revoked
   *  (undefined), or unreachable. */
  github?: (githubToken: string) => string | { login: string; id: number } | undefined | 'down';
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
  const lookups: string[] = [];
  const stored = async (sha: string) => uploads.has(sha) || (await storage.blob(sha)) !== undefined;

  const looking = (name: 'skill' | 'version' | 'byFingerprint' | 'versions' | 'fileState') => async (...args: unknown[]) => {
    lookups.push(name);
    return (storage[name] as (...a: unknown[]) => Promise<unknown>).apply(storage, args);
  };
  const hosted: Storage = Object.assign(Object.create(storage), {
    skill: looking('skill'),
    version: looking('version'),
    byFingerprint: looking('byFingerprint'),
    versions: looking('versions'),
    fileState: looking('fileState'),
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
      return typeof said === 'string' ? { login: said, id: 1 } : said;
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
    lookups,
    close() {
      catalog.close();
      local.close();
    },
  };
}
