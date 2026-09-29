// The catalog operations (contract §2), over the ports (§7). Local or hosted is only a choice of adapters.

import { CatalogError } from './errors.ts';
import type { BlobStore, Clock, Events, Ids, MetadataStore, SearchCard, SearchIndex, VersionRecord } from './ports.ts';
import { DEFAULT_SEARCH_LIMIT, VERSIONS_PAGE, validateInput } from './registry.ts';
import {
  DEFAULT_CAPABILITY_KEYS,
  DEFAULT_LIMITS,
  MANIFEST,
  checkManifest,
  checkName,
  checkTree,
  diffTrees,
  entryOf,
  fingerprint as fingerprintOf,
  isText,
  decodeText,
  sha256Hex,
  type FileChange,
  type Limits,
  type Mode,
  type RiskFlag,
  type TreeDiff,
  type TreeFile,
} from './skill-tree/index.ts';
import { COMMON_WORDS, contentWords, spelledLike } from './words.ts';

export interface CatalogConfig {
  limits: Limits;
  capabilityKeys: readonly string[];
  commonWords: readonly string[];
}

export const DEFAULT_CONFIG: CatalogConfig = { limits: DEFAULT_LIMITS, capabilityKeys: DEFAULT_CAPABILITY_KEYS, commonWords: COMMON_WORDS };

export interface CatalogPorts {
  meta: MetadataStore;
  blobs: BlobStore;
  index: SearchIndex;
  events: Events;
  clock: Clock;
  ids: Ids;
  config?: Partial<CatalogConfig>;
  close?: () => void;
}

// ---------- shapes ----------

export interface SearchInput {
  query?: string;
  filters?: { tags?: string[]; publisher?: string; updated_since?: string };
  limit?: number;
  cursor?: string;
}

export interface Card {
  name: string;
  description: string;
  latest_version: number;
  tags: string[];
  publisher: string;
  matched_words: string[];
}

export interface SearchResult {
  results: Card[];
  match: 'all' | 'partial' | 'none';
  ranking: 'none' | 'lexical';
  next_cursor?: string;
  total_matches: number;
  catalog_size: number;
}

export interface ReadInput {
  name?: string;
  names?: string[];
  version?: number;
  include?: 'manifest' | 'files' | 'contents';
}

export interface ReadFile {
  path: string;
  mode: Mode;
  size: number;
  sha256: string;
  type: 'text' | 'binary';
  content?: string;
}

export interface ReadItem {
  name: string;
  version: number;
  latest_version: number;
  fingerprint: string;
  published_at: string;
  publisher: string;
  manifest: { frontmatter: Record<string, unknown>; body: string };
  reviews: unknown[];
  files?: ReadFile[];
}

export type ReadEntry = ReadItem | { name: string; error: Record<string, unknown> & { code: string } };

export interface VersionsResult {
  name: string;
  latest: number;
  versions: { version: number; fingerprint: string; published_at: string; publisher: string; message: string; flags: RiskFlag[] }[];
  next_cursor?: string;
}

export interface DiffResult extends TreeDiff {
  name: string;
  from: number;
  to: number;
}

export interface PublishInput {
  name: string;
  files: { path: string; mode: string; content_base64: string }[];
  message?: string;
  expected_latest?: number;
  dry_run?: boolean;
}

export interface PublishResult {
  name: string;
  version: number;
  fingerprint: string;
  created: boolean;
  dry_run: boolean;
  publisher: string;
  diff_from_latest: TreeDiff | null;
  risk_flags: RiskFlag[];
}

export interface FetchInput {
  name?: string;
  version?: number;
  fingerprint?: string;
}

export interface FetchResult {
  name: string;
  version: number;
  fingerprint: string;
  files: { path: string; mode: Mode; content_base64: string }[];
}

// ---------- helpers ----------

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ACTOR = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const APPEND_TRIES = 5;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
    if (Number.isInteger(o) && o >= 0) return o;
  } catch {
    // falls through
  }
  throw new CatalogError('invalid_request', { field: 'cursor', why: 'not a cursor this catalog gave out' });
}

function checkActor(actor: unknown): string {
  if (actor === undefined || actor === null || actor === '') throw new CatalogError('unauthenticated', { why: 'no acting developer' });
  if (typeof actor !== 'string' || !ACTOR.test(actor)) throw new CatalogError('invalid_request', { field: 'as', why: 'a developer name: lowercase letters, digits, . _ -' });
  return actor;
}

function cardOf(v: VersionRecord): SearchCard {
  return { name: v.name, description: v.description, latest_version: v.version, tags: v.tags, publisher: v.publisher, updated_at: v.published_at };
}

// ---------- the catalog ----------

export class Catalog {
  readonly config: CatalogConfig;
  private readonly p: CatalogPorts;

  constructor(ports: CatalogPorts) {
    this.p = ports;
    this.config = { ...DEFAULT_CONFIG, ...ports.config };
    // The search index is the first listener on version_published (§5.1 step 4). It reads the latest version rather
    // than trusting the event's order, so a repeated or late delivery can't put an old card back.
    ports.events.subscribe((e) => this.indexSkill(e.name));
    ports.events.deliver();
  }

  close(): void {
    this.p.close?.();
  }

  private indexSkill(name: string): void {
    const s = this.p.meta.skill(name);
    const v = s && this.p.meta.version(name, s.latest);
    if (v) this.p.index.upsert(cardOf(v));
  }

  rebuildIndex(): void {
    this.p.index.rebuild([...this.p.meta.latestVersions()].map(cardOf));
  }

  private notFound(name: string, extra: Record<string, unknown> = {}): CatalogError {
    return new CatalogError('not_found', { name, suggestions: spelledLike(name, this.p.meta.names()), ...extra });
  }

  private versionOf(name: string, version?: number): { record: VersionRecord; latest: number } {
    checkName(name);
    const s = this.p.meta.skill(name);
    if (!s) throw this.notFound(name);
    const record = this.p.meta.version(name, version ?? s.latest);
    if (!record) throw new CatalogError('not_found', { name, version, latest: s.latest, suggestions: [] });
    return { record, latest: s.latest };
  }

  // A version's files, each checked against its sha256 on the way out.
  private tree(v: VersionRecord): TreeFile[] {
    return v.files.map((f) => {
      const bytes = this.p.blobs.get(f.sha256);
      if (!bytes) throw new Error(`storage: ${v.name} v${v.version} is missing the bytes of ${f.path} (${f.sha256})`);
      if (sha256Hex(bytes) !== f.sha256) throw new Error(`storage: ${v.name} v${v.version} ${f.path} does not match its sha256`);
      return { path: f.path, mode: f.mode, bytes };
    });
  }

  // search_shared_skills
  search(input: unknown): SearchResult {
    const req = validateInput<SearchInput>('search_shared_skills', input);
    const offset = decodeCursor(req.cursor);
    const limit = req.limit ?? DEFAULT_SEARCH_LIMIT;
    this.p.events.deliver();
    const query = req.query?.trim() ?? '';
    const words = query ? contentWords(query, this.config.commonWords) : [];
    const hits = this.p.index.query(words, req.filters ?? {});
    const page = hits.slice(offset, offset + limit);
    const out: SearchResult = {
      results: page.map(({ card, matched_words }) => ({
        name: card.name,
        description: card.description,
        latest_version: card.latest_version,
        tags: card.tags,
        publisher: card.publisher,
        matched_words,
      })),
      match: hits.length === 0 ? 'none' : words.length === 0 || hits.some((h) => h.matched_words.length === words.length) ? 'all' : 'partial',
      ranking: words.length === 0 ? 'none' : 'lexical',
      total_matches: hits.length,
      catalog_size: this.p.index.count(),
    };
    if (offset + limit < hits.length) out.next_cursor = encodeCursor(offset + limit);
    return out;
  }

  // read_shared_skill
  read(input: unknown): { skills: ReadEntry[] } {
    const req = validateInput<ReadInput>('read_shared_skill', input);
    if (req.name !== undefined && req.names !== undefined) throw new CatalogError('invalid_request', { field: 'names', why: 'give name or names, not both' });
    const wanted = req.names ?? (req.name !== undefined ? [req.name] : []);
    if (wanted.length === 0) throw new CatalogError('invalid_request', { field: 'name', why: 'required' });
    const include = req.include ?? 'manifest';
    const one = (name: string): ReadItem => {
      const { record, latest } = this.versionOf(name, req.version);
      const tree = this.tree(record);
      const md = checkManifest(tree, name);
      const item: ReadItem = {
        name,
        version: record.version,
        latest_version: latest,
        fingerprint: record.fingerprint,
        published_at: record.published_at,
        publisher: record.publisher,
        manifest: { frontmatter: md.frontmatter, body: md.body },
        reviews: [],
      };
      if (include !== 'manifest') {
        item.files = tree.map((f) => {
          const text = isText(f.bytes);
          const file: ReadFile = { path: f.path, mode: f.mode, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes), type: text ? 'text' : 'binary' };
          if (include === 'contents' && text) file.content = decodeText(f.bytes);
          return file;
        });
      }
      return item;
    };
    if (req.names === undefined) return { skills: [one(wanted[0]!)] };
    return {
      skills: wanted.map((name) => {
        try {
          return one(name);
        } catch (e) {
          if (e instanceof CatalogError) return { name, error: e.toJSON() as Record<string, unknown> & { code: string } };
          throw e;
        }
      }),
    };
  }

  // list_shared_skill_versions
  versions(input: unknown): VersionsResult {
    const req = validateInput<{ name: string; cursor?: string }>('list_shared_skill_versions', input);
    const offset = decodeCursor(req.cursor);
    const { latest } = this.versionOf(req.name);
    const rows = this.p.meta.versions(req.name, offset, VERSIONS_PAGE);
    const out: VersionsResult = {
      name: req.name,
      latest,
      versions: rows.map((v) => ({ version: v.version, fingerprint: v.fingerprint, published_at: v.published_at, publisher: v.publisher, message: v.message, flags: [] })),
    };
    if (offset + VERSIONS_PAGE < latest) out.next_cursor = encodeCursor(offset + VERSIONS_PAGE);
    return out;
  }

  // diff_shared_skill_versions
  diff(input: unknown): DiffResult {
    const req = validateInput<{ name: string; from: number; to: number }>('diff_shared_skill_versions', input);
    const a = this.versionOf(req.name, req.from).record;
    const b = this.versionOf(req.name, req.to).record;
    const d = diffTrees({ files: this.tree(a), publisher: a.publisher }, { files: this.tree(b), publisher: b.publisher }, this.config.capabilityKeys);
    return { name: req.name, from: a.version, to: b.version, ...d };
  }

  // publish_version: validate, put the bytes, compare-and-append (the commit point), then the event (§5.1).
  publish(input: unknown, actor: unknown): PublishResult {
    const req = validateInput<PublishInput>('publish_version', input);
    const publisher = checkActor(actor);
    const name = checkName(req.name);
    const raw = req.files.map((f, i) => {
      if (!BASE64.test(f.content_base64)) throw new CatalogError('invalid_request', { field: `files[${i}].content_base64`, why: 'not base64' });
      return { path: f.path, mode: f.mode, bytes: Buffer.from(f.content_base64, 'base64') };
    });
    const tree = checkTree(raw, this.config.limits);
    const md = checkManifest(tree, name);
    const entries = tree.map(entryOf);
    const fingerprint = fingerprintOf(entries);

    // Checked before any byte is stored, so a refused publish leaves storage exactly as it was; the append checks
    // again, atomically, for a publish that raced this one.
    const skill = this.p.meta.skill(name);
    if (skill && !skill.owners.includes(publisher)) throw new CatalogError('not_owner', { name, owners: skill.owners });
    const latestNo = skill?.latest ?? 0;
    if (req.expected_latest !== undefined && req.expected_latest !== latestNo) throw new CatalogError('conflict', { name, latest: latestNo, expected_latest: req.expected_latest });
    const latest = skill ? this.p.meta.version(name, latestNo) : undefined;
    const diff = diffTrees(latest ? { files: this.tree(latest), publisher: latest.publisher } : null, { files: tree, publisher }, this.config.capabilityKeys);
    const result = (version: number, created: boolean): PublishResult => ({
      name,
      version,
      fingerprint,
      created,
      dry_run: req.dry_run === true,
      publisher,
      diff_from_latest: latest ? diff : null,
      risk_flags: created || req.dry_run ? diff.risk_flags : [],
    });
    if (latest && latest.fingerprint === fingerprint) return { ...result(latest.version, false), diff_from_latest: { ...diff, files: [] }, risk_flags: [] };
    if (req.dry_run) return result(latestNo + 1, false);

    const added = new Set<string>();
    const putAll = () => {
      for (const f of tree) if (this.p.blobs.put(sha256Hex(f.bytes), f.bytes)) added.add(sha256Hex(f.bytes));
    };
    // A refused or failed commit takes back the blobs this publish added that no version references, under the write
    // lock, so storage is exactly as it was (rows and blobs) even when another publish won the race.
    const takeBack = () => {
      try {
        this.p.meta.withWriteLock(() => {
          for (const sha of added) if (!this.p.meta.referencesBlob(sha)) this.p.blobs.delete(sha);
        });
      } catch {
        // Left for a later cleanup; no version points at them.
      }
    };
    putAll();
    const record: Omit<VersionRecord, 'version'> = {
      name,
      fingerprint,
      publisher,
      message: req.message ?? '',
      published_at: this.p.clock.now().toISOString(),
      files: entries,
      description: md.description,
      tags: md.tags,
      frontmatter: md.frontmatter,
    };
    const event = (version: number) => ({ type: 'version_published' as const, name, version, fingerprint, publisher, at: record.published_at });
    for (let attempt = 1; ; attempt++) {
      let r;
      try {
        // Every blob must still be there at the commit point: a racing publish may have taken back one this
        // publish found already stored. If so, put them again and retry.
        r = this.p.meta.withWriteLock(() =>
          entries.every((e) => this.p.blobs.has(e.sha256)) ? this.p.meta.append(record, { expectedLatest: req.expected_latest }, event) : null,
        );
      } catch (e) {
        // A clash on the version number or a busy lock: try again.
        if (attempt < APPEND_TRIES && /UNIQUE|constraint|busy|locked/i.test(String((e as Error).message))) continue;
        takeBack();
        throw e;
      }
      if (r === null) {
        if (attempt >= APPEND_TRIES) throw new Error('storage: blobs kept disappearing before the commit');
        putAll();
        continue;
      }
      switch (r.kind) {
        case 'not_owner':
          takeBack();
          throw new CatalogError('not_owner', { name, owners: r.owners });
        case 'conflict':
          takeBack();
          throw new CatalogError('conflict', { name, latest: r.latest, expected_latest: req.expected_latest });
        case 'identical':
          takeBack();
          return { ...result(r.record.version, false), diff_from_latest: { ...diff, files: [] }, risk_flags: [] };
        case 'created':
          try {
            this.p.events.deliver();
          } catch {
            // The version is committed; its event stays in the outbox and the next delivery (a search, the next
            // process to open the catalog) retries it. The search index may lag; it never loses a version.
          }
          return result(r.record.version, true);
      }
    }
  }

  // fetch_version: the bytes, by name and version or by fingerprint; cacheable by fingerprint.
  fetch(input: unknown): FetchResult {
    const req = validateInput<FetchInput>('fetch_version', input);
    let record: VersionRecord | undefined;
    if (req.fingerprint !== undefined) {
      if (req.name !== undefined || req.version !== undefined) throw new CatalogError('invalid_request', { field: 'fingerprint', why: 'give a fingerprint, or a name and version' });
      record = this.p.meta.byFingerprint(req.fingerprint);
      if (!record) throw new CatalogError('not_found', { fingerprint: req.fingerprint, suggestions: [] });
    } else {
      if (req.name === undefined || req.version === undefined) throw new CatalogError('invalid_request', { field: req.name === undefined ? 'name' : 'version', why: 'required' });
      record = this.versionOf(req.name, req.version).record;
    }
    const files = this.tree(record).map((f) => ({ path: f.path, mode: f.mode, content_base64: Buffer.from(f.bytes).toString('base64') }));
    return { name: record.name, version: record.version, fingerprint: record.fingerprint, files };
  }
}

export type { FileChange, RiskFlag, TreeDiff };
export { MANIFEST };
