// The ports (contract §7): where a choice can change. Every port is async, so a hosted adapter (DynamoDB and S3,
// a remote index, a sign-in) drops in behind the same interfaces. Phase 1 has the local adapters (src/local/).

import type { FileEntry, Review } from './skill-tree/index.ts';

export interface SkillRecord {
  name: string;
  owners: string[];
  latest: number;
}

export interface VersionRecord {
  name: string;
  version: number;
  fingerprint: string;
  publisher: string;
  message: string;
  published_at: string;
  files: FileEntry[];
  description: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
}

// A new version as the publish hands it to storage: its record, plus the reviews run on it (contract §10), which storage
// keeps as their own records with that version, in the same commit, and never inside the version record.
export type NewVersion = Omit<VersionRecord, 'version'> & { reviews?: readonly Review[] | undefined };

export interface VersionPublished {
  type: 'version_published';
  name: string;
  version: number;
  fingerprint: string;
  publisher: string;
  at: string;
}

export type CommitResult =
  | { kind: 'created'; record: VersionRecord }
  | { kind: 'identical'; record: VersionRecord }
  | { kind: 'conflict'; latest: number }
  | { kind: 'not_owner'; owners: string[] }
  // A file named by its sha256 alone that isn't stored (contract §1.1); nothing is changed.
  | { kind: 'not_uploaded'; missing: string[] };

// Storage: the contract's MetadataStore (versions, the latest pointer) and BlobStore (bytes by sha256), with the
// publish's commit point behind them (§5.1 steps 2-3). How the two stay consistent is the adapter's business:
// locally one SQLite lock and a folder; hosted, create-only S3 puts then one conditional DynamoDB write.
export type FileState = 'named' | 'on_its_way' | 'unknown';

export interface Storage {
  skill(name: string): Promise<SkillRecord | undefined>;
  version(name: string, version: number): Promise<VersionRecord | undefined>;
  byFingerprint(fingerprint: string): Promise<VersionRecord | undefined>;
  versions(name: string, offset: number, limit: number): Promise<VersionRecord[]>; // newest first
  latestVersions(): Promise<VersionRecord[]>; // every skill's latest, for rebuilding the index
  names(): Promise<string[]>;
  count(): Promise<number>; // names, not versions
  blob(sha256: string): Promise<Uint8Array | undefined>;
  // Whether some stored version names this file (§1.1, the files route). Hosted, a file uploaded or claimed under a day
  // ago and not marked for removal, that no version names yet, is on its way (the lookup is written seconds after a
  // publish); locally the lookup is immediate, so never.
  fileState(sha256: string): Promise<FileState>;
  // Stores the bytes, then compare-and-appends the version with its version_published event, atomically. A file
  // given by its sha256 alone (hosted: already uploaded) is checked inside the commit instead: one not stored is
  // not_uploaded. Refused (conflict, not_owner, identical, not_uploaded): commit changes nothing; hosted, files uploaded
  // ahead of it stay unreferenced until the sweep. Never: a version that points at a missing blob.
  commit(
    v: NewVersion,
    files: readonly { sha256: string; bytes?: Uint8Array | undefined }[],
    cond: { expectedLatest?: number | undefined },
    event: (version: number) => VersionPublished,
  ): Promise<CommitResult>;
  // A version's reviews (contract §10), one per reviewer: a commit stores the ones its NewVersion carries; a reviewer run
  // again later (an offline sweep) replaces its own. Listed by reviewer id; none for a version or skill that isn't there.
  putReview(name: string, version: number, review: Review): Promise<void>;
  reviews(name: string, version: number): Promise<Review[]>;
}

export interface SearchCard {
  name: string;
  description: string;
  latest_version: number;
  tags: string[];
  publisher: string;
  updated_at: string;
}

export interface SearchFilters {
  tags?: string[] | undefined;
  publisher?: string | undefined;
  updated_since?: string | undefined;
}

export interface SearchHit {
  card: SearchCard;
  matched_words: string[];
}

// Keyword search (any word, stemmed, ranked): may lag the versions, and is rebuildable from them at any time.
export interface SearchIndex {
  upsert(card: SearchCard): Promise<void>;
  query(words: string[], filters: SearchFilters): Promise<SearchHit[]>; // all hits, best first, with the words each matched; no words = all cards by name
  rebuild(cards: readonly SearchCard[]): Promise<void>;
}

// Publish events, delivered at least once, in order. Locally an outbox table next to the versions.
export interface Events {
  subscribe(handler: (e: VersionPublished) => Promise<void>): void;
  deliver(): Promise<number>; // delivers what's pending; returns how many
}

// Who is asking (§7 "Who may publish"). Locally "act as" a developer; hosted, a verified sign-in or token, whose scope
// the hosted transport always gives (an operation that checks it treats a hosted caller without one as a bug; locally
// there's no scope and no limit).
export interface Identity {
  actor(): Promise<string | undefined>;
  scope?(): Promise<TokenScope | undefined>;
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(): string;
}

// What a request for upload links answers per file (§1.1): a link to put one not stored; "stored" for one that is
// (claimed by the asking, so a commit in the next day takes it); "removing" for one the sweep is taking away, with when
// to try again.
export type UploadAnswer =
  | { kind: 'upload'; sha256: string; url: string; headers: Record<string, string> }
  | { kind: 'stored'; sha256: string }
  | { kind: 'removing'; sha256: string; retry_after: string };

// Short-lived links (§1.1, §7), hosted only: to put a file by its sha256 before a publish names it, and to a stored
// file's bytes, so the files route and a hosted fetch answer with a link instead of reading the bytes.
export interface BlobLinks {
  uploadLinks(files: readonly { sha256: string; size: number }[]): Promise<UploadAnswer[]>;
  downloadLink(sha256: string): Promise<string>;
}

// Who holds a hosted catalog's Bearer token (§1.1): a GitHub sign-in session or a personal token, with a scope.
export type TokenScope = 'read' | 'publish';
export type TokenKind = 'session' | 'personal';
export interface TokenHolder {
  owner: string;
  scope: TokenScope;
  kind: TokenKind;
}

// A token as its owner sees it listed (§1.1 "Getting a token, hosted"): by its public id, never the token or its hash.
export interface TokenInfo extends TokenHolder {
  id: string;
  created_at: string;
  expires_at: string;
  last_used_at?: string;
  revoked_at?: string;
}

// The hosted catalog's tokens, hosted only: stored hashed, each with a public id; unknown, revoked or expired is nobody.
// A token's last use is recorded at most once an hour. Revoking is by its owner only (another's id changes nothing),
// up to a scope (a read token revokes read tokens), and deletes nothing. The store also keeps GitHub's numeric id for
// each login that has signed in, so a login GitHub frees and someone else takes can't sign in as the first.
export interface TokenStore {
  issue(t: TokenHolder & { expiresAt: Date }): Promise<{ id: string; token: string }>;
  verify(token: string): Promise<TokenHolder | undefined>;
  list(owner: string): Promise<TokenInfo[]>; // oldest first
  liveCount(owner: string): Promise<number>; // not revoked, not expired
  // 'none': no token of theirs has that id; 'above': theirs, but of a scope above upTo (unchanged).
  revoke(owner: string, id: string, upTo: TokenScope): Promise<'revoked' | 'none' | 'above'>;
  // The login's first call records the id; true when the id is the one recorded (the login given in lowercase).
  bindLogin(login: string, githubId: number): Promise<boolean>;
}

// Signing in with GitHub (§1.1), hosted only: the login and numeric id of a GitHub token issued to the catalog's own
// OAuth app, by GitHub's check for that app's tokens; undefined when GitHub says it isn't one (another app's, revoked,
// unknown). GitHub unreachable, or any answer but those, is thrown, never undefined: a person whose sign-in is fine is
// never told it's wrong.
export interface GitHubSignIn {
  login(githubToken: string): Promise<{ login: string; id: number } | undefined>;
}
