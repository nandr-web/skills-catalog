// The ports (contract §7): where a choice can change. Every port is async, so a hosted adapter (DynamoDB and S3,
// a remote index, a sign-in) drops in behind the same interfaces. Phase 1 has the local adapters (src/local/).

import type { FileEntry } from './skill-tree/index.ts';

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

export type NewVersion = Omit<VersionRecord, 'version'>;

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
  // not_uploaded. Refused (conflict, not_owner, identical, not_uploaded): storage is left exactly as it was. Never: a
  // version that points at a missing blob.
  commit(
    v: NewVersion,
    files: readonly { sha256: string; bytes?: Uint8Array | undefined }[],
    cond: { expectedLatest?: number | undefined },
    event: (version: number) => VersionPublished,
  ): Promise<CommitResult>;
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

// Who is asking (§7 "Who may publish"). Locally "act as" a developer; hosted, a verified sign-in or token.
export interface Identity {
  actor(): Promise<string | undefined>;
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(): string;
}

// Short-lived links to a stored file's bytes (§1.1, §7), hosted only: where it's wired, the files route answers with a
// link instead of reading the bytes.
export interface BlobLinks {
  downloadLink(sha256: string): Promise<string>;
}
