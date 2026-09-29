// The ports (contract §7): where a choice can change. Phase 1 has the local adapters (src/local/); the hosted ones
// plug in behind the same interfaces.

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

export interface VersionPublished {
  type: 'version_published';
  name: string;
  version: number;
  fingerprint: string;
  publisher: string;
  at: string;
}

export type AppendResult =
  | { kind: 'created'; record: VersionRecord }
  | { kind: 'identical'; record: VersionRecord }
  | { kind: 'conflict'; latest: number }
  | { kind: 'not_owner'; owners: string[] };

// Versions and the latest pointer. `append` is the commit point of a publish (§5.1 step 3): one atomic
// compare-and-append that also records the version_published event, so an event is never lost or invented.
export interface MetadataStore {
  skill(name: string): SkillRecord | undefined;
  version(name: string, version: number): VersionRecord | undefined;
  byFingerprint(fingerprint: string): VersionRecord | undefined;
  versions(name: string, offset: number, limit: number): VersionRecord[]; // newest first
  latestVersions(): Iterable<VersionRecord>; // every skill's latest, for rebuilding the index
  names(): string[];
  count(): number;
  append(
    v: Omit<VersionRecord, 'version'>,
    cond: { expectedLatest?: number | undefined },
    event: (version: number) => VersionPublished,
  ): AppendResult;
}

// File bytes by sha256: put-if-absent, safe to repeat.
export interface BlobStore {
  put(sha256: string, bytes: Uint8Array): void;
  get(sha256: string): Uint8Array | undefined;
  has(sha256: string): boolean;
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

// Keyword search (any word, ranked): may lag the versions, and is rebuildable from them at any time.
export interface SearchIndex {
  upsert(card: SearchCard): void;
  query(words: string[], filters: SearchFilters): SearchHit[]; // all hits, best first, with the words each matched; no words = all cards by name
  rebuild(cards: Iterable<SearchCard>): void;
  count(): number;
}

// Publish events, delivered at least once, in order. Locally an outbox table next to the versions.
export interface Events {
  subscribe(handler: (e: VersionPublished) => void): void;
  deliver(): number; // delivers what's pending; returns how many
}

export interface Clock {
  now(): Date;
}

export interface Ids {
  next(): string;
}
