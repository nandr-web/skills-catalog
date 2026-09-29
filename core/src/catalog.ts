// The catalog operations (contract §2), over the ports (§7). Local or hosted is only a choice of adapters: nothing
// here knows how versions and bytes are stored or kept consistent.

import { CatalogError } from './errors.ts';
import type { BlobLinks, Clock, Events, Identity, Ids, SearchCard, SearchIndex, Storage, UploadAnswer, VersionRecord } from './ports.ts';
import { DEFAULT_SEARCH_LIMIT, SHA256_PATTERN, VERSIONS_PAGE, validateInput, type Face, type Where } from './api.ts';

// Each operation checks its input as the face its caller gives (contract §1.1): the client passes its own, the web page's
// server 'web'. A person-only input (publish's allow_suspected_secrets) passes only as the CLI's; a caller that gives no
// face is checked as the strictest, so such an input is refused, never let through.
const CATALOG_FACE: Face = 'mcp';
import {
  DEFAULT_NON_GRANTING_KEYS,
  DEFAULT_SAFE_FRONTMATTER_KEYS,
  DEFAULT_LIMITS,
  MANIFEST,
  checkManifest,
  checkName,
  checkTree,
  diffTrees,
  entryOf,
  fingerprint as fingerprintOf,
  hasLineBreakOrControl,
  isText,
  decodeText,
  sha256Hex,
  scanSecrets,
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
  safeFrontmatterKeys: readonly string[]; // keys that can't grant anything; a change to any other key is a risk flag
  nonGrantingKeys: readonly string[]; // keys known to grant nothing: with only these, a changed file is no reason to ask
  commonWords: readonly string[];
  readInlineBudget: number; // bytes of text one read inlines (contract §2: 24 KB keeps a result under 8,000 tokens)
}

export const DEFAULT_CONFIG: CatalogConfig = {
  limits: DEFAULT_LIMITS,
  safeFrontmatterKeys: DEFAULT_SAFE_FRONTMATTER_KEYS,
  nonGrantingKeys: DEFAULT_NON_GRANTING_KEYS,
  commonWords: COMMON_WORDS,
  readInlineBudget: 24 * 1024,
};

export interface CatalogPorts {
  where: Where; // said, never inferred: a hosted catalog has a links port and a local one has none (checked at open)
  storage: Storage;
  index: SearchIndex;
  events: Events;
  identity: Identity;
  clock: Clock;
  ids: Ids;
  config?: Partial<CatalogConfig>;
  close?: () => void;
  links?: BlobLinks; // hosted only: files go up and come back by link, never as bytes in a request or an answer
}

// A stored version's file, as the files route answers it (§1.1): its bytes (local), a link to them (hosted), on its
// way (hosted, seconds after a publish), or unknown.
export type FileAnswer = { kind: 'bytes'; bytes: Uint8Array } | { kind: 'link'; url: string } | { kind: 'on_its_way' } | { kind: 'unknown' };
const SHA256_HEX = new RegExp(SHA256_PATTERN);
// How many uploaded files a hosted publish reads at once.
const UPLOAD_READS = 8;

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
  paths?: string[];
}

export interface ReadFile {
  path: string;
  mode: Mode;
  size: number;
  sha256: string;
  type: 'text' | 'binary';
  content?: string;
  content_omitted?: boolean;
}

export interface InlineBudget {
  limit: number;
  used: number;
  omitted: number;
}

export interface ReadItem {
  name: string;
  version: number;
  latest_version: number;
  fingerprint: string;
  published_at: string;
  publisher: string;
  // The front matter always comes; the body only when it fits the read's budget (body_omitted otherwise), and with
  // paths[] only when SKILL.md is one of them (no body_omitted then).
  manifest: { frontmatter: Record<string, unknown>; body?: string; body_omitted?: true };
  reviews: unknown[];
  files?: ReadFile[];
}

export type ReadEntry = ReadItem | { name: string; error: Record<string, unknown> & { code: string } };

export interface ReadResult {
  skills: ReadEntry[];
  inline_budget: InlineBudget;
}

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

// A file as a publish names it: its bytes inline (local), or its sha256 once uploaded through a link (hosted).
export type InlineFile = { path: string; mode: string; content_base64: string };
export type UploadedFile = { path: string; mode: string; sha256: string };

export interface PublishInput {
  name: string;
  files: InlineFile[] | UploadedFile[];
  message?: string;
  expected_latest?: number;
  dry_run?: boolean;
  allow_suspected_secrets?: boolean;
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
  // Inline locally; hosted, each file by its sha256 and size with a short-lived link to its bytes.
  files: InlineFetched[] | LinkedFetched[];
}

export type InlineFetched = { path: string; mode: Mode; content_base64: string };
export type LinkedFetched = { path: string; mode: Mode; sha256: string; size: number; url: string };

// A fetch's files with their bytes inline, as a local catalog answers. A hosted catalog's come by link, which a caller
// that reads bytes from the answer doesn't follow: refused, never read as empty.
export function inlineFiles(r: FetchResult): InlineFetched[] {
  if (r.files.every((f) => 'content_base64' in f)) return r.files as InlineFetched[];
  throw new Error("this fetch answered with links (a hosted catalog's); the bytes are at each file's url");
}

export interface UploadLinksInput {
  name: string;
  files: { sha256: string; size: number }[];
}

export interface UploadLinksResult {
  name: string;
  files: UploadAnswer[];
}

// ---------- helpers ----------

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// A developer name, the acting identity (the faces check SKILLS_AS and --as with it once, at start). It follows the
// skill-name rule (contract §4.1): 1-64 lowercase letters, digits and single hyphens, so it is always one line.
export const ACTOR = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
// No catalog pages this far; a larger offset is a cursor this catalog never gave out.
const MAX_CURSOR_OFFSET = 1_000_000;

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

// A search or versions cursor's offset (the faces need it to say "showing 11-20"); a cursor this catalog didn't give out
// is invalid_request.
export function cursorOffset(cursor: string | undefined): number {
  return decodeCursor(cursor);
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const o = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')).o;
    if (Number.isSafeInteger(o) && o >= 0 && o <= MAX_CURSOR_OFFSET) return o;
  } catch {
    // falls through
  }
  throw new CatalogError('invalid_request', { field: 'cursor', why: 'not_a_cursor' });
}

// `field` names where the name came from: the --as flag by default, or a request's own field.
export function checkActor(actor: unknown, field = '--as'): string {
  if (actor === undefined || actor === null || actor === '') throw new CatalogError('unauthenticated', {});
  if (typeof actor !== 'string' || !ACTOR.test(actor)) throw new CatalogError('invalid_request', { field, why: 'not_a_developer_name' });
  return actor;
}

// The decoded size of a base64 string, without decoding it.
function decodedSize(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

// Size limits checked on the request itself, before any byte is decoded (a huge request never reaches memory twice).
function checkRequestSize(files: InlineFile[], limits: Limits): void {
  checkSizes(
    files.map((f, i) => {
      if (!BASE64.test(f.content_base64)) throw new CatalogError('invalid_request', { field: `files[${i}].content_base64`, why: 'not_base64' });
      return { size: decodedSize(f.content_base64), path: f.path };
    }),
    limits,
  );
}

// The size limits (contract §4.2) on each file's size and their total, in order: a file over the file limit, else the
// first file that takes the total over the skill limit. A request for upload links states its sizes; a publish's are
// its bytes'.
function checkSizes(files: readonly { size: number; path?: string }[], limits: Limits): void {
  if (files.length > limits.files) throw new CatalogError('too_large', { limit: 'files', max: limits.files, value: files.length });
  let total = 0;
  for (const f of files) {
    if (f.size > limits.file_bytes) throw new CatalogError('too_large', { limit: 'file_bytes', max: limits.file_bytes, value: f.size, ...(f.path !== undefined ? { path: f.path } : {}) });
    total += f.size;
    if (total > limits.skill_bytes) throw new CatalogError('too_large', { limit: 'skill_bytes', max: limits.skill_bytes, value: total });
  }
}

function inline(files: InlineFile[], limits: Limits): { path: string; mode: string; bytes: Uint8Array }[] {
  checkRequestSize(files, limits);
  return files.map((f) => ({ path: f.path, mode: f.mode, bytes: Buffer.from(f.content_base64, 'base64') }));
}

// A file named by something that isn't a sha256 (§9): known before anything is looked up.
function checkSha256s(files: readonly { sha256: string }[]): void {
  for (const [i, f] of files.entries()) if (!SHA256_HEX.test(f.sha256)) throw new CatalogError('invalid_request', { field: `files[${i}].sha256`, why: 'not_sha256' });
}

const notUploaded = (i: number) => new CatalogError('invalid_request', { field: `files[${i}].sha256`, why: 'not_uploaded' });

function cardOf(v: VersionRecord): SearchCard {
  return { name: v.name, description: v.description, latest_version: v.version, tags: v.tags, publisher: v.publisher, updated_at: v.published_at };
}

// ---------- the catalog ----------

export class Catalog {
  readonly config: CatalogConfig;
  private readonly p: CatalogPorts;

  private constructor(ports: CatalogPorts) {
    this.p = ports;
    this.config = { ...DEFAULT_CONFIG, ...ports.config };
    // The search index is the first listener on version_published (§5.1 step 4). It reads the latest version rather
    // than trusting the event's order, so a repeated or late delivery can't put an old card back.
    ports.events.subscribe((e) => this.indexSkill(e.name));
  }

  // Opens the catalog over its ports and delivers any events a crashed process left pending.
  static async open(ports: CatalogPorts): Promise<Catalog> {
    if (ports.where !== 'local' && ports.where !== 'hosted') throw new Error(`where the catalog runs must be said: 'local' or 'hosted', not ${String(ports.where)}`);
    if (ports.where === 'hosted' && !ports.links) throw new Error('a hosted catalog needs a links port (its files are served by link)');
    if (ports.where === 'local' && ports.links) throw new Error('a local catalog has no links port (its files are served as bytes)');
    const catalog = new Catalog(ports);
    await ports.events.deliver();
    return catalog;
  }

  get where(): Where {
    return this.p.where;
  }

  close(): void {
    this.p.close?.();
  }

  private async indexSkill(name: string): Promise<void> {
    const s = await this.p.storage.skill(name);
    const v = s && (await this.p.storage.version(name, s.latest));
    if (v) await this.p.index.upsert(cardOf(v));
  }

  async rebuildIndex(): Promise<void> {
    await this.p.index.rebuild((await this.p.storage.latestVersions()).map(cardOf));
  }

  private async notFound(name: string): Promise<CatalogError> {
    return new CatalogError('not_found', { name, suggestions: spelledLike(name, await this.p.storage.names()) });
  }

  private async versionOf(name: string, version?: number): Promise<{ record: VersionRecord; latest: number }> {
    checkName(name);
    const s = await this.p.storage.skill(name);
    if (!s) throw await this.notFound(name);
    const record = await this.p.storage.version(name, version ?? s.latest);
    if (!record) throw new CatalogError('not_found', { name, version, latest: s.latest, suggestions: [] });
    return { record, latest: s.latest };
  }

  // A version's files, each checked against its sha256 on the way out.
  private async tree(v: VersionRecord): Promise<TreeFile[]> {
    return Promise.all(
      v.files.map(async (f) => {
        const bytes = await this.p.storage.blob(f.sha256);
        if (!bytes) throw new Error(`storage: ${v.name} v${v.version} is missing the bytes of ${f.path} (${f.sha256})`);
        if (sha256Hex(bytes) !== f.sha256) throw new Error(`storage: ${v.name} v${v.version} ${f.path} does not match its sha256`);
        return { path: f.path, mode: f.mode, bytes };
      }),
    );
  }

  // search_shared_skills
  async search(input: unknown, face: Face = CATALOG_FACE): Promise<SearchResult> {
    const req = validateInput<SearchInput>('search_shared_skills', input, face, this.p.where);
    const offset = decodeCursor(req.cursor);
    const limit = req.limit ?? DEFAULT_SEARCH_LIMIT;
    await this.p.events.deliver();
    const query = req.query?.trim() ?? '';
    const words = query ? contentWords(query, this.config.commonWords) : [];
    const hits = await this.p.index.query(words, req.filters ?? {});
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
      catalog_size: await this.p.storage.count(),
    };
    if (offset + limit < hits.length) out.next_cursor = encodeCursor(offset + limit);
    return out;
  }

  // read_shared_skill
  async read(input: unknown, face: Face = CATALOG_FACE): Promise<ReadResult> {
    const req = validateInput<ReadInput>('read_shared_skill', input, face, this.p.where);
    if (req.name !== undefined && req.names !== undefined) throw new CatalogError('invalid_request', { field: 'names', why: 'name_and_names' });
    if (req.paths !== undefined && req.name === undefined) throw new CatalogError('invalid_request', { field: 'paths', why: 'paths_need_one_name' });
    const wanted = req.names ?? (req.name !== undefined ? [req.name] : []);
    if (wanted.length === 0) throw new CatalogError('invalid_request', { field: 'name', why: 'required' });
    // Asking for particular files means reading them.
    const include = req.include ?? (req.paths !== undefined ? 'contents' : 'manifest');
    // What this read may inline (contract §2): each skill's body, and with contents its text files.
    const bodies = new Map<ReadItem, string>();
    const texts = new Map<ReadFile, Uint8Array>();
    const one = async (name: string): Promise<ReadItem> => {
      const { record, latest } = await this.versionOf(name, req.version);
      const tree = await this.tree(record);
      const md = checkManifest(tree, name);
      const item: ReadItem = {
        name,
        version: record.version,
        latest_version: latest,
        fingerprint: record.fingerprint,
        published_at: record.published_at,
        publisher: record.publisher,
        manifest: { frontmatter: md.frontmatter },
        reviews: [],
      };
      if (req.paths === undefined || req.paths.some((p) => p.normalize('NFC') === MANIFEST)) bodies.set(item, md.body);
      let shown = tree;
      if (req.paths !== undefined) {
        const byPath = new Map(tree.map((f) => [f.path, f]));
        shown = req.paths.map((p) => {
          const f = byPath.get(p.normalize('NFC'));
          if (!f) throw new CatalogError('not_found', { name, version: record.version, path: p, suggestions: [] });
          return f;
        });
      }
      if (include !== 'manifest') {
        item.files = shown.map((f) => {
          const text = isText(f.bytes);
          const file: ReadFile = { path: f.path, mode: f.mode, size: f.bytes.byteLength, sha256: sha256Hex(f.bytes), type: text ? 'text' : 'binary' };
          if (include === 'contents' && text) texts.set(file, f.bytes);
          return file;
        });
      }
      return item;
    };
    const skills: ReadEntry[] = [];
    if (req.names === undefined) skills.push(await one(wanted[0]!));
    else {
      for (const name of wanted) {
        try {
          skills.push(await one(name));
        } catch (e) {
          if (!(e instanceof CatalogError)) throw e;
          skills.push({ name, error: e.toJSON() as Record<string, unknown> & { code: string } });
        }
      }
    }
    return { skills, inline_budget: this.inline(skills, bodies, texts, req.paths) };
  }

  // A read inlines at most the configured budget of text (contract §2), each text whole or not at all, in this order:
  // every skill's body in the order asked, then each skill's text files, skill by skill, SKILL.md first and then by
  // path. With paths[], only the named files in the order asked, the body just before SKILL.md when it is named, and
  // a single named path is inlined whatever its size (every stored file is within the file limit). A body or file
  // that doesn't fit is marked omitted (a body only without paths[]), and later smaller ones may still fit.
  private inline(skills: ReadEntry[], bodies: Map<ReadItem, string>, texts: Map<ReadFile, Uint8Array>, paths?: readonly string[]): InlineBudget {
    const limit = this.config.readInlineBudget;
    const items = skills.filter((e): e is ReadItem => !('error' in e));
    interface Slot {
      bytes: number;
      put(): void;
      omit(): void;
    }
    const body = (i: ReadItem): Slot[] => {
      const text = bodies.get(i);
      if (text === undefined) return [];
      return [{ bytes: Buffer.byteLength(text, 'utf8'), put: () => (i.manifest.body = text), omit: () => paths === undefined && (i.manifest.body_omitted = true) }];
    };
    const file = (f: ReadFile): Slot[] => {
      const bytes = texts.get(f);
      if (bytes === undefined) return [];
      return [{ bytes: bytes.byteLength, put: () => (f.content = decodeText(bytes)), omit: () => (f.content_omitted = true) }];
    };
    const byPath = (i: ReadItem) => [...(i.files ?? []).filter((f) => f.path === MANIFEST), ...(i.files ?? []).filter((f) => f.path !== MANIFEST)];
    const order =
      paths !== undefined
        ? items.flatMap((i) => (i.files ?? []).flatMap((f) => [...(f.path === MANIFEST ? body(i) : []), ...file(f)]))
        : [...items.flatMap(body), ...items.flatMap((i) => byPath(i).flatMap(file))];
    // With paths[] but without include: files or contents there are no files to walk: the body still comes for SKILL.md.
    if (paths !== undefined && order.length === 0) for (const i of items) order.push(...body(i));
    const alone = paths?.length === 1;
    let used = 0;
    let omitted = 0;
    for (const slot of order) {
      if (alone || used + slot.bytes <= limit) {
        slot.put();
        used += slot.bytes;
      } else {
        slot.omit();
        omitted++;
      }
    }
    return { limit, used, omitted };
  }

  // list_shared_skill_versions
  async versions(input: unknown, face: Face = CATALOG_FACE): Promise<VersionsResult> {
    const req = validateInput<{ name: string; cursor?: string }>('list_shared_skill_versions', input, face, this.p.where);
    const offset = decodeCursor(req.cursor);
    const { latest } = await this.versionOf(req.name);
    const rows = await this.p.storage.versions(req.name, offset, VERSIONS_PAGE);
    const out: VersionsResult = {
      name: req.name,
      latest,
      versions: rows.map((v) => ({ version: v.version, fingerprint: v.fingerprint, published_at: v.published_at, publisher: v.publisher, message: v.message, flags: [] })),
    };
    if (offset + VERSIONS_PAGE < latest) out.next_cursor = encodeCursor(offset + VERSIONS_PAGE);
    return out;
  }

  // diff_shared_skill_versions
  async diff(input: unknown, face: Face = CATALOG_FACE): Promise<DiffResult> {
    const req = validateInput<{ name: string; from: number; to: number }>('diff_shared_skill_versions', input, face, this.p.where);
    const a = (await this.versionOf(req.name, req.from)).record;
    const b = (await this.versionOf(req.name, req.to)).record;
    const d = diffTrees({ files: await this.tree(a), publisher: a.publisher }, { files: await this.tree(b), publisher: b.publisher }, this.config.safeFrontmatterKeys, this.config.nonGrantingKeys);
    return { name: req.name, from: a.version, to: b.version, ...d };
  }

  // publish_version: check, then the storage's commit point, then the event (§5.1). The publisher is the acting
  // identity (the given one, else the catalog's), never a field in the request or the front matter.
  async publish(input: unknown, identity: Identity = this.p.identity, face: Face = CATALOG_FACE): Promise<PublishResult> {
    const req = validateInput<PublishInput>('publish_version', input, face, this.p.where);
    // A version's message is a one-line field (contract §2, §4.1).
    if (req.message !== undefined && hasLineBreakOrControl(req.message)) throw new CatalogError('invalid_request', { field: 'message', why: 'control_character' });
    const publisher = checkActor(await identity.actor());
    const name = checkName(req.name);

    // One order of refusals, dry run or not: not_owner, then conflict, then the files. Owner and latest are checked
    // before any byte is stored, so a refused publish leaves storage exactly as it was; the storage's commit
    // checks again, atomically, for a publish that raced this one.
    const skill = await this.p.storage.skill(name);
    if (skill && !skill.owners.includes(publisher)) throw new CatalogError('not_owner', { name, owners: skill.owners });
    const latestNo = skill?.latest ?? 0;
    if (req.expected_latest !== undefined && req.expected_latest !== latestNo) throw new CatalogError('conflict', { name, latest: latestNo, expected_latest: req.expected_latest });

    const raw = this.p.where === 'hosted' ? await this.uploaded(req.files as UploadedFile[]) : inline(req.files as InlineFile[], this.config.limits);
    const tree = checkTree(raw, this.config.limits);
    const md = checkManifest(tree, name);
    // The secret scan: a hit refuses the publish, dry run or not, unless the person allowed it for this one (§2).
    const secret = req.allow_suspected_secrets === true ? null : scanSecrets(tree);
    if (secret) throw new CatalogError('secret_suspected', { ...secret });
    const entries = tree.map(entryOf);
    const fingerprint = fingerprintOf(entries);
    const latest = skill ? await this.p.storage.version(name, latestNo) : undefined;
    const diff = diffTrees(latest ? { files: await this.tree(latest), publisher: latest.publisher } : null, { files: tree, publisher }, this.config.safeFrontmatterKeys, this.config.nonGrantingKeys);
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
    const unchanged = (version: number): PublishResult => ({ ...result(version, false), diff_from_latest: { ...diff, files: [] }, risk_flags: [] });
    if (latest && latest.fingerprint === fingerprint) return unchanged(latest.version);
    if (req.dry_run) return result(latestNo + 1, false);

    const at = this.p.clock.now().toISOString();
    // Hosted, the commit names each file by its sha256 alone and checks it's still stored and usable (§1.1).
    const hosted = this.p.where === 'hosted';
    const r = await this.p.storage.commit(
      { name, fingerprint, publisher, message: req.message ?? '', published_at: at, files: entries, description: md.description, tags: md.tags, frontmatter: md.frontmatter },
      tree.map((f) => (hosted ? { sha256: sha256Hex(f.bytes) } : { sha256: sha256Hex(f.bytes), bytes: f.bytes })),
      { expectedLatest: req.expected_latest },
      (version) => ({ type: 'version_published', name, version, fingerprint, publisher, at }),
    );
    switch (r.kind) {
      case 'not_owner':
        throw new CatalogError('not_owner', { name, owners: r.owners });
      case 'conflict':
        throw new CatalogError('conflict', { name, latest: r.latest, expected_latest: req.expected_latest });
      case 'identical':
        return unchanged(r.record.version);
      case 'not_uploaded': {
        // Locally every file came with its bytes, so a file missing at the commit is a bug (internal_error). Hosted, a
        // file read for the checks can be swept or age out before the commit looks: the first such file, by its place
        // in the request.
        const i = hosted ? (req.files as UploadedFile[]).findIndex((f) => r.missing.includes(f.sha256)) : -1;
        if (i >= 0) throw notUploaded(i);
        throw new Error(`commit found ${r.missing.length} file(s) not stored although their bytes were given`);
      }
      case 'created':
        try {
          await this.p.events.deliver();
        } catch {
          // The version is committed; its event stays in the outbox and the next delivery (a search, the next
          // process to open the catalog) retries it. The search index may lag; it never loses a version.
        }
        return result(r.record.version, true);
    }
  }

  // fetch_version: the bytes, by name and version or by fingerprint; cacheable by fingerprint.
  async fetch(input: unknown, face: Face = CATALOG_FACE): Promise<FetchResult> {
    const req = validateInput<FetchInput>('fetch_version', input, face, this.p.where);
    let record: VersionRecord | undefined;
    if (req.fingerprint !== undefined) {
      if (req.name !== undefined || req.version !== undefined) throw new CatalogError('invalid_request', { field: 'fingerprint', why: 'fingerprint_or_name_and_version' });
      record = await this.p.storage.byFingerprint(req.fingerprint);
      if (!record) throw new CatalogError('not_found', { fingerprint: req.fingerprint, suggestions: [] });
    } else {
      if (req.name === undefined || req.version === undefined) throw new CatalogError('invalid_request', { field: req.name === undefined ? 'name' : 'version', why: 'required' });
      record = (await this.versionOf(req.name, req.version)).record;
    }
    // Hosted, links straight from the version read here (strongly consistent), never through the files route's lookup.
    if (this.p.where === 'hosted') {
      const links = this.p.links!;
      const files = await Promise.all(record.files.map(async (f) => ({ path: f.path, mode: f.mode, sha256: f.sha256, size: f.size, url: await links.downloadLink(f.sha256) })));
      return { name: record.name, version: record.version, fingerprint: record.fingerprint, files };
    }
    const files = (await this.tree(record)).map((f) => ({ path: f.path, mode: f.mode, content_base64: Buffer.from(f.bytes).toString('base64') }));
    return { name: record.name, version: record.version, fingerprint: record.fingerprint, files };
  }

  // request_upload_links (hosted only, §1.1): every check a publish makes before its files (who is asking, the name
  // theirs or new, the sizes), then a link for each file not stored; the links port claims each stored one.
  async uploadLinks(input: unknown, identity: Identity = this.p.identity, face: Face = CATALOG_FACE): Promise<UploadLinksResult> {
    const req = validateInput<UploadLinksInput>('request_upload_links', input, face, this.p.where);
    const publisher = checkActor(await identity.actor());
    const name = checkName(req.name);
    const skill = await this.p.storage.skill(name);
    if (skill && !skill.owners.includes(publisher)) throw new CatalogError('not_owner', { name, owners: skill.owners });
    checkSha256s(req.files);
    checkSizes(req.files, this.config.limits);
    return { name, files: await this.p.links!.uploadLinks(req.files.map((f) => ({ sha256: f.sha256, size: f.size }))) };
  }

  // The hosted form's files: each one's bytes as stored, read UPLOAD_READS at a time and checked in the request's order,
  // so the first refusal is the same as one by one, and the size limits stop the reads a batch past the limit. Every
  // file's sha256 is checked before anything is looked up (not_sha256); one not stored, or whose bytes don't hash to its
  // name, was never uploaded.
  private async uploaded(files: UploadedFile[]): Promise<{ path: string; mode: string; bytes: Uint8Array }[]> {
    const limits = this.config.limits;
    if (files.length > limits.files) throw new CatalogError('too_large', { limit: 'files', max: limits.files, value: files.length });
    checkSha256s(files);
    const out: { path: string; mode: string; bytes: Uint8Array }[] = [];
    let total = 0;
    for (let at = 0; at < files.length; at += UPLOAD_READS) {
      const batch = files.slice(at, at + UPLOAD_READS);
      const read = await Promise.all(batch.map((f) => this.p.storage.blob(f.sha256)));
      for (const [j, f] of batch.entries()) {
        const bytes = read[j];
        if (bytes === undefined || sha256Hex(bytes) !== f.sha256) throw notUploaded(at + j);
        if (bytes.length > limits.file_bytes) throw new CatalogError('too_large', { limit: 'file_bytes', max: limits.file_bytes, value: bytes.length, path: f.path });
        total += bytes.length;
        if (total > limits.skill_bytes) throw new CatalogError('too_large', { limit: 'skill_bytes', max: limits.skill_bytes, value: total });
        out.push({ path: f.path, mode: f.mode, bytes });
      }
    }
    return out;
  }

  // A stored version's file by its sha256 (§1.1, the files route; not an operation, so no face): only a file some
  // version names, its bytes checked on the way out as a fetch checks them, or a link where links are wired.
  async file(sha256: string): Promise<FileAnswer> {
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) return { kind: 'unknown' };
    const state = await this.p.storage.fileState(sha256);
    if (state !== 'named') return { kind: state };
    if (this.p.links) return { kind: 'link', url: await this.p.links.downloadLink(sha256) };
    const bytes = await this.p.storage.blob(sha256);
    if (!bytes) throw new Error(`storage: the file ${sha256} a version names has no bytes`);
    if (sha256Hex(bytes) !== sha256) throw new Error(`storage: the file ${sha256} does not match its sha256`);
    return { kind: 'bytes', bytes };
  }
}

export type { FileChange, RiskFlag, TreeDiff };
export { MANIFEST };
