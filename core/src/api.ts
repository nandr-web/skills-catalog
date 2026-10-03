// The API (contract §1): each operation is defined once, with a typed input schema, and the faces (CLI, MCP,
// later HTTP) are generated from it. Slice 1 holds the catalog operations; the machine operations join in slice 2.

import { CatalogError, ERROR_CODES, type ErrorCode } from './errors.ts';
import { MAX_TAGS, MODES, TAG_MAX_LENGTH } from './skill-tree/index.ts';

export type Schema =
  | { type: 'string'; enum?: readonly string[]; maxLength?: number; minLength?: number; pattern?: string }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: Schema; maxItems?: number }
  | { type: 'object'; properties: Record<string, Schema>; required?: readonly string[] };

// An operation's result as JSON Schema (OpenAPI 3.1 takes it as it is): an object lists every field it has, the
// optional ones left out of `required`; `{}` is any value (a front matter value, a flag's old and new values).
export type OutputSchema =
  | { type: 'string'; enum?: readonly string[] }
  | { type: 'integer' }
  | { type: 'number' }
  | { type: 'boolean' }
  | { type: 'null' }
  | { type: 'array'; items: OutputSchema }
  | { type: 'object'; properties: Record<string, OutputSchema>; required: readonly string[]; additionalProperties?: boolean | OutputSchema }
  | { anyOf: readonly OutputSchema[] }
  | Record<string, never>;

// The faces an operation can be served on (contract §1): the assistant's tools, the CLI, the web page (HTTP, §1.1).
export type Face = 'mcp' | 'cli' | 'web';

// Where the catalog runs (contract §1.1): locally, or hosted. Said when it's opened, never inferred; faces say who
// calls, this says where the catalog is.
export type Where = 'local' | 'hosted';

export interface OperationDef {
  name: string;
  kind: 'catalog' | 'machine';
  phase: 1 | 2 | 'aws' | 'later';
  // Where it's served; the web face serves catalog operations only.
  faces: readonly Face[];
  // What it changes: nothing, the catalog, or this machine's installed skills.
  effect: 'reads' | 'writes_catalog' | 'writes_machine';
  // The code that runs it, by name: a Catalog method for a catalog operation, the client's machine operation otherwise.
  run: string;
  words?: string; // its key in the words file (the tool's words), for operations with an MCP tool
  input: Extract<Schema, { type: 'object' }>;
  // Its result: a schema for a catalog operation; a machine operation answers in text for now.
  output: OutputSchema | 'text';
  // The codes it can raise besides COMMON_ERRORS (a test proves them with the golden error rows).
  errors: readonly ErrorCode[];
  // Inputs only a person at the CLI gives (contract §3): never in the MCP or web schema, and refused from those faces.
  cliOnly?: readonly string[];
  // Served only by a hosted catalog (absent: served by both).
  where?: 'hosted';
  // Inputs that take another form on a hosted catalog; each form refuses the other (unknown_field).
  hostedForm?: Record<string, Schema>;
  // Its result on a hosted catalog, where that differs (a fetch answers links there, not bytes).
  hostedOutput?: OutputSchema;
  // Called with no Bearer token (hosted): only signing in, which is how one is got.
  token?: 'none';
  // The operation checks the caller's token scope itself (hosted), so a read-scope token isn't refused before it runs
  // even though it changes the catalog: revoking, where a read token may revoke read tokens.
  checksScope?: true;
  // Its method acts as someone: it takes the acting identity after the input, then the face (a publish, the upload
  // links, the token operations); every other method takes the face after the input.
  acts?: true;
}

// Request limits are errors that name the field and the limit, never silent clamps (contract §9).
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_READ_NAMES = 20;
export const VERSIONS_PAGE = 50;
export const MAX_READ_PATHS = 20;

export const MAX_UPDATE_NAMES = 100;
// Where a skill installs (contract §3): the person's own skills folder, or the current project's.
export const TARGETS = ['user', 'project'] as const;
export const POLICIES = ['auto', 'notify', 'pin'] as const;

// The risk flags' kinds (contract §5.3), as a publish's step 2 repeats them.
export const FLAG_KINDS = ['runnable_file', 'runs_at_load', 'command_instruction', 'capability_frontmatter', 'instructions_changed', 'non_markdown', 'new_publisher', 'prompt_injection', 'context_cost'] as const;

const name = { type: 'string', maxLength: 200 } as const;
const version = { type: 'integer', minimum: 1 } as const;

// The catalog operations' results (catalog.ts's result types), field for field; a test checks what each one really
// returns against these, so a field added or dropped in the code shows here.
const str: OutputSchema = { type: 'string' };
const int: OutputSchema = { type: 'integer' };
const bool: OutputSchema = { type: 'boolean' };
const anyValue: OutputSchema = {};
const oneOf = (...values: readonly string[]): OutputSchema => ({ type: 'string', enum: values });
const list = (items: OutputSchema): OutputSchema => ({ type: 'array', items });
// Closed: a field the code adds or drops shows as a schema change (JSON Schema leaves an object open unless it says so).
const obj = (properties: Record<string, OutputSchema>, optional: readonly string[] = []): OutputSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
  additionalProperties: false,
});
const riskFlag = obj({ kind: oneOf(...FLAG_KINDS), path: str, line: int, field: str, from: anyValue, to: anyValue, detail: str, advice: bool }, ['path', 'line', 'field', 'from', 'to', 'advice']);
// A review (contract §10): who reviewed which fingerprint and when, what it measured (numbers by name), its flags, each
// finding grounded (where, the text it rests on, why), and notes only when they help.
const finding = obj({ kind: oneOf(...FLAG_KINDS), path: str, line: int, evidence: str, why: str, advice: bool }, ['path', 'line', 'advice']);
const review = obj(
  {
    reviewer: str,
    reviewer_version: str,
    fingerprint: str,
    at: str,
    measurements: { type: 'object', properties: {}, required: [], additionalProperties: { type: 'number' } },
    flags: list(riskFlag),
    findings: list(finding),
    notes: str,
    // Findings past the review's limits (a few of each kind in each file, a few in all), counted by kind.
    omitted: list(obj({ kind: oneOf(...FLAG_KINDS), count: int })),
  },
  ['notes', 'omitted'],
);
// A card's quality: only when a review flagged something (contract §10).
const quality = obj({ flags: list(riskFlag) });
const treeDiff = {
  files: list(obj({ path: str, status: oneOf('added', 'changed', 'removed'), flags: obj({ binary: bool, executable: bool, script: bool }), unified: str }, ['unified'])),
  frontmatter_changes: list(obj({ field: str, from: anyValue, to: anyValue })),
  publisher_changed: bool,
  risk_flags: list(riskFlag),
};
const mode = oneOf(...MODES);
const SEARCH_OUTPUT = obj(
  {
    results: list(obj({ name: str, quality, description: str, latest_version: int, tags: list(str), publisher: str, matched_words: list(str) }, ['quality'])),
    match: oneOf('all', 'partial', 'none'),
    ranking: oneOf('none', 'lexical'),
    next_cursor: str,
    total_matches: int,
    catalog_size: int,
  },
  ['next_cursor'],
);
const readItem = obj(
  {
    name: str,
    version: int,
    latest_version: int,
    fingerprint: str,
    published_at: str,
    publisher: str,
    manifest: obj({ frontmatter: { type: 'object', properties: {}, required: [], additionalProperties: true }, body: str, body_omitted: bool }, ['body', 'body_omitted']),
    reviews: list(review),
    reviews_omitted: bool,
    files: list(obj({ path: str, mode, size: int, sha256: str, type: oneOf('text', 'binary'), content: str, content_omitted: bool }, ['content', 'content_omitted'])),
  },
  ['reviews_omitted', 'files'],
);
// A name a read of several couldn't give: its own error, with the fields that error has.
const readMissing = obj({ name: str, error: { type: 'object', properties: { code: oneOf(...ERROR_CODES) }, required: ['code'], additionalProperties: true } });
const READ_OUTPUT = obj({ skills: list({ anyOf: [readItem, readMissing] }), inline_budget: obj({ limit: int, used: int, omitted: int }) });
const VERSIONS_OUTPUT = obj(
  { name: str, latest: int, versions: list(obj({ version: int, fingerprint: str, published_at: str, publisher: str, message: str, flags: list(riskFlag) })), next_cursor: str },
  ['next_cursor'],
);
const DIFF_OUTPUT = obj({ name: str, from: int, to: int, ...treeDiff });
const PUBLISH_OUTPUT = obj({
  name: str,
  version: int,
  fingerprint: str,
  created: bool,
  dry_run: bool,
  publisher: str,
  diff_from_latest: { anyOf: [obj(treeDiff), { type: 'null' }] },
  risk_flags: list(riskFlag),
});
const FETCH_OUTPUT = obj({ name: str, version: int, fingerprint: str, files: list(obj({ path: str, mode, content_base64: str })) });
const FETCH_OUTPUT_HOSTED = obj({ name: str, version: int, fingerprint: str, files: list(obj({ path: str, mode, sha256: str, size: int, url: str })) });
// Each file's answer is one of three, each with its own fields (the port's UploadAnswer).
const UPLOAD_LINKS_OUTPUT = obj({
  name: str,
  files: list({
    anyOf: [
      obj({ kind: oneOf('upload'), sha256: str, url: str, headers: { type: 'object', properties: {}, required: [], additionalProperties: str } }),
      obj({ kind: oneOf('stored'), sha256: str }),
      obj({ kind: oneOf('removing'), sha256: str, retry_after: str }),
    ],
  }),
});
// A file named by its sha256 (hosted, after its upload). The pattern is for the published schema; the catalog refuses a
// value that doesn't match it (not_sha256) before it looks anything up (a test holds the two together).
export const SHA256_PATTERN = '^[0-9a-f]{64}$';
const sha256 = { type: 'string', pattern: SHA256_PATTERN } as const;
// A token's public id (hosted). Like the sha256's, the pattern is for the published schema; the catalog refuses a value
// that doesn't match it (not_a_token_id, never repeating it) before it looks anything up.
export const TOKEN_ID_PATTERN = '^[A-Za-z0-9_-]{16}$';
// The most files one publish may name, in either form (the request's own cap; the skill's file limit is config).
const MAX_PUBLISH_FILES = 10_000;
const tokenInfo = obj({ id: str, scope: oneOf('read', 'publish'), kind: oneOf('session', 'personal'), created_at: str, expires_at: str, last_used_at: str, revoked_at: str }, ['last_used_at', 'revoked_at']);
// The most files one request for upload links may name (contract §1.1).
export const MAX_UPLOAD_LINKS = 100;

export const OPERATIONS: Record<string, OperationDef> = {
  search_shared_skills: {
    name: 'search_shared_skills',
    words: 'search',
    kind: 'catalog',
    phase: 1,
    faces: ['mcp', 'cli', 'web'],
    effect: 'reads',
    run: 'search',
    output: SEARCH_OUTPUT,
    errors: [],
    input: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 500 },
        filters: {
          type: 'object',
          properties: {
            // A skill's own tag rule (contract §4.1, §9): more tags or longer ones can't match anything.
            tags: { type: 'array', items: { type: 'string', maxLength: TAG_MAX_LENGTH }, maxItems: MAX_TAGS },
            publisher: { type: 'string', maxLength: 200 },
            updated_since: { type: 'string', maxLength: 40 },
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_SEARCH_LIMIT },
        cursor: { type: 'string', maxLength: 200 },
      },
    },
  },
  read_shared_skill: {
    name: 'read_shared_skill',
    words: 'get',
    kind: 'catalog',
    phase: 1,
    faces: ['mcp', 'cli', 'web'],
    effect: 'reads',
    run: 'read',
    output: READ_OUTPUT,
    errors: ['invalid_name', 'not_found'],
    input: {
      type: 'object',
      properties: {
        name,
        names: { type: 'array', items: name, maxItems: MAX_READ_NAMES },
        version,
        include: { type: 'string', enum: ['manifest', 'files', 'contents'] },
        paths: { type: 'array', items: { type: 'string', maxLength: 4096 }, maxItems: MAX_READ_PATHS },
      },
    },
  },
  list_shared_skill_versions: {
    name: 'list_shared_skill_versions',
    words: 'versions',
    kind: 'catalog',
    phase: 1,
    faces: ['mcp', 'cli', 'web'],
    effect: 'reads',
    run: 'versions',
    output: VERSIONS_OUTPUT,
    errors: ['invalid_name', 'not_found'],
    input: { type: 'object', properties: { name, cursor: { type: 'string', maxLength: 200 } }, required: ['name'] },
  },
  diff_shared_skill_versions: {
    name: 'diff_shared_skill_versions',
    words: 'diff',
    kind: 'catalog',
    phase: 1,
    faces: ['mcp', 'cli', 'web'],
    effect: 'reads',
    run: 'diff',
    output: DIFF_OUTPUT,
    errors: ['invalid_name', 'not_found'],
    input: { type: 'object', properties: { name, from: version, to: version }, required: ['name', 'from', 'to'] },
  },
  publish_version: {
    name: 'publish_version',
    kind: 'catalog',
    phase: 1,
    faces: ['web'],
    effect: 'writes_catalog',
    run: 'publish',
    acts: true,
    output: PUBLISH_OUTPUT,
    errors: ['unauthenticated', 'not_owner', 'conflict', 'invalid_manifest', 'invalid_name', 'invalid_path', 'too_large', 'secret_suspected'],
    input: {
      type: 'object',
      properties: {
        name,
        files: {
          type: 'array',
          items: {
            type: 'object',
            properties: { path: { type: 'string', maxLength: 4096 }, mode: { type: 'string', maxLength: 8 }, content_base64: { type: 'string' } },
            required: ['path', 'mode', 'content_base64'],
          },
          maxItems: MAX_PUBLISH_FILES,
        },
        message: { type: 'string', maxLength: 1000 },
        expected_latest: { type: 'integer', minimum: 0 },
        dry_run: { type: 'boolean' },
        allow_suspected_secrets: { type: 'boolean' }, // a person's override, per publish; never in an MCP schema
      },
      required: ['name', 'files'],
    },
    hostedForm: {
      files: {
        type: 'array',
        items: { type: 'object', properties: { path: { type: 'string', maxLength: 4096 }, mode: { type: 'string', maxLength: 8 }, sha256 }, required: ['path', 'mode', 'sha256'] },
        maxItems: MAX_PUBLISH_FILES,
      },
    },
    cliOnly: ['allow_suspected_secrets'],
  },
  request_upload_links: {
    name: 'request_upload_links',
    kind: 'catalog',
    phase: 'aws',
    faces: ['web'],
    where: 'hosted',
    // It claims every stored file it's asked about (§1.1), so a publish in the next day takes it.
    effect: 'writes_catalog',
    run: 'uploadLinks',
    acts: true,
    output: UPLOAD_LINKS_OUTPUT,
    errors: ['unauthenticated', 'not_owner', 'invalid_name', 'too_large'],
    input: {
      type: 'object',
      properties: {
        name,
        files: { type: 'array', items: { type: 'object', properties: { sha256, size: { type: 'integer', minimum: 0 } }, required: ['sha256', 'size'] }, maxItems: MAX_UPLOAD_LINKS },
      },
      required: ['name', 'files'],
    },
  },
  sign_in_with_github: {
    name: 'sign_in_with_github',
    kind: 'catalog',
    phase: 'aws',
    faces: ['web'],
    where: 'hosted',
    token: 'none',
    effect: 'writes_catalog', // it issues a token
    run: 'signIn',
    output: obj({ token: str, id: str, scope: oneOf('read', 'publish'), expires_at: str }),
    errors: ['unauthenticated'],
    input: {
      type: 'object',
      properties: { github_token: { type: 'string', maxLength: 255 }, scope: { type: 'string', enum: ['read', 'publish'] } },
      required: ['github_token', 'scope'],
    },
  },
  list_tokens: {
    name: 'list_tokens',
    kind: 'catalog',
    phase: 'aws',
    faces: ['web'],
    where: 'hosted',
    effect: 'reads',
    run: 'listTokens',
    acts: true,
    output: obj({ tokens: list(tokenInfo) }),
    errors: ['unauthenticated'],
    input: { type: 'object', properties: {} },
  },
  revoke_token: {
    name: 'revoke_token',
    kind: 'catalog',
    phase: 'aws',
    faces: ['web'],
    where: 'hosted',
    effect: 'writes_catalog',
    run: 'revokeToken',
    acts: true,
    checksScope: true,
    output: obj({ id: str }),
    errors: ['unauthenticated', 'not_found'],
    input: { type: 'object', properties: { id: { type: 'string', pattern: TOKEN_ID_PATTERN } }, required: ['id'] },
  },
  fetch_version: {
    name: 'fetch_version',
    kind: 'catalog',
    phase: 1,
    faces: ['web'],
    effect: 'reads',
    run: 'fetch',
    output: FETCH_OUTPUT,
    hostedOutput: FETCH_OUTPUT_HOSTED,
    errors: ['invalid_name', 'not_found'],
    input: { type: 'object', properties: { name, version, fingerprint: { type: 'string', maxLength: 80 } } },
  },

  // Machine operations (contract §3): they run in the client, on this machine; the CLI and the MCP server are their faces.
  publish_skill_to_catalog: {
    name: 'publish_skill_to_catalog',
    words: 'publish',
    kind: 'machine',
    phase: 1,
    faces: ['mcp'],
    effect: 'writes_catalog',
    run: 'publishFolder',
    output: 'text',
    errors: ['conflict', 'unauthenticated', 'not_owner', 'invalid_manifest', 'invalid_name', 'invalid_path', 'too_large', 'secret_suspected'],
    input: {
      type: 'object',
      properties: {
        folder: { type: 'string', maxLength: 4096 },
        message: { type: 'string', maxLength: 1000 },
        confirm: { type: 'string', maxLength: 2000 },
        // Step 2 repeats what step 1 showed, so the person's permission prompt shows what they agree to (contract §3).
        name,
        version,
        files: { type: 'integer', minimum: 0 },
        flags: { type: 'array', items: { type: 'string', enum: FLAG_KINDS }, maxItems: 20 },
        allow_suspected_secrets: { type: 'boolean' },
      },
      required: ['folder'],
    },
    cliOnly: ['allow_suspected_secrets'],
  },
  install_shared_skill: {
    name: 'install_shared_skill',
    words: 'install',
    kind: 'machine',
    phase: 1,
    faces: ['mcp', 'cli'],
    effect: 'writes_machine',
    run: 'install',
    output: 'text',
    errors: ['not_found', 'invalid_manifest', 'invalid_name', 'invalid_path', 'too_large', 'fingerprint_mismatch', 'exists_untracked', 'name_in_use', 'target_symlink', 'target_changed', 'target_not_private', 'target_unavailable', 'lock_busy', 'invalid_local_file'],
    input: {
      type: 'object',
      properties: { name, version, target: { type: 'string', enum: TARGETS }, policy: { type: 'string', enum: POLICIES } },
      required: ['name'],
    },
    cliOnly: ['policy'],
  },
  update_installed_skills: {
    name: 'update_installed_skills',
    words: 'update',
    kind: 'machine',
    phase: 1,
    faces: ['mcp', 'cli'],
    effect: 'writes_machine',
    run: 'update',
    output: 'text',
    // A skill it can't update is a refused line in its answer, not an error: only these stop the whole call.
    errors: ['not_installed', 'not_found', 'lock_busy', 'invalid_local_file'],
    input: {
      type: 'object',
      properties: { names: { type: 'array', items: name, maxItems: MAX_UPDATE_NAMES }, dry_run: { type: 'boolean' }, latest: { type: 'boolean' } },
    },
    cliOnly: ['latest'],
  },
  accept_held_update: {
    name: 'accept_held_update',
    words: 'accept',
    kind: 'machine',
    phase: 1,
    faces: ['mcp', 'cli'],
    effect: 'writes_machine',
    run: 'accept',
    output: 'text',
    errors: ['conflict', 'not_installed', 'not_found', 'invalid_manifest', 'invalid_name', 'invalid_path', 'too_large', 'fingerprint_mismatch', 'exists_untracked', 'name_in_use', 'target_symlink', 'target_changed', 'target_not_private', 'target_unavailable', 'lock_busy', 'invalid_local_file'],
    input: {
      type: 'object',
      properties: { name, target: { type: 'string', enum: TARGETS }, version, confirm: { type: 'string', maxLength: 2000 }, flags: { type: 'array', items: { type: 'string', maxLength: 40 }, maxItems: 20 } },
      required: ['name', 'target', 'version', 'confirm', 'flags'],
    },
  },
  list_installed_skills: {
    name: 'list_installed_skills',
    words: 'status',
    kind: 'machine',
    phase: 1,
    faces: ['mcp', 'cli'],
    effect: 'reads',
    run: 'list',
    output: 'text',
    errors: ['not_found', 'invalid_local_file'],
    input: { type: 'object', properties: {} },
  },
  set_skill_update_policy: {
    name: 'set_skill_update_policy',
    words: 'policy',
    kind: 'machine',
    phase: 1,
    faces: ['mcp', 'cli'],
    effect: 'writes_machine',
    run: 'setPolicy',
    output: 'text',
    errors: ['not_installed', 'lock_busy', 'invalid_local_file'],
    input: { type: 'object', properties: { policy: { type: 'string', enum: POLICIES }, name }, required: ['policy'] },
  },
};

// An operation's input schema as one face sees it, where the catalog runs: the MCP and web faces never get the CLI-only
// inputs, and a hosted catalog takes an input's hosted form. No defaults: a caller that forgets the face must not get
// the CLI's inputs, and one that forgets where must not get the other place's form.
export function inputSchema(op: string | OperationDef, face: Face, where: Where): OperationDef['input'] {
  const def = typeof op === 'string' ? OPERATIONS[op]! : op;
  let properties = def.input.properties;
  if (where === 'hosted' && def.hostedForm) properties = { ...properties, ...def.hostedForm };
  if (face !== 'cli' && def.cliOnly?.length) properties = Object.fromEntries(Object.entries(properties).filter(([k]) => !def.cliOnly!.includes(k)));
  return properties === def.input.properties ? def.input : { ...def.input, properties };
}

// Whether the HTTP API serves an operation where the catalog runs: its row has the web face and isn't only for the other
// place. By name (as a route reads it), only the table's own keys are operations.
export function webRow(op: string | OperationDef, where: Where): boolean {
  const def = typeof op === 'string' ? (Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : undefined) : op;
  return def !== undefined && def.faces.includes('web') && (def.where === undefined || def.where === where);
}

function fail(field: string, why: string, extra: Record<string, unknown> = {}): never {
  throw new CatalogError('invalid_request', { field, why, ...extra });
}

// An unknown key is the request's own text, so an answer names at most its first MAX_ECHOED_KEY whole characters (a
// pair of UTF-16 halves is one character, never split) and says it cut it (contract §9).
const MAX_ECHOED_KEY = 200;
function unknownField(path: string, key: string): never {
  let end = 0;
  for (let n = 0; n < MAX_ECHOED_KEY && end < key.length; n++) end += key.codePointAt(end)! > 0xffff ? 2 : 1;
  const prefix = path ? `${path}.` : '';
  if (end >= key.length) fail(prefix + key, 'unknown_field');
  fail(prefix + key.slice(0, end), 'unknown_field', { field_cut: true });
}

function check(schema: Schema, value: unknown, field: string): void {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') fail(field, 'not_text');
      if (schema.enum && !schema.enum.includes(value)) fail(field, 'not_one_of', { allowed: schema.enum });
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(field, 'too_long', { limit: schema.maxLength, value: value.length });
      return;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) fail(field, 'not_integer');
      if (schema.minimum !== undefined && value < schema.minimum) fail(field, 'too_low', { limit: schema.minimum, value });
      if (schema.maximum !== undefined && value > schema.maximum) fail(field, 'too_high', { limit: schema.maximum, value });
      return;
    case 'boolean':
      if (typeof value !== 'boolean') fail(field, 'not_boolean');
      return;
    case 'array':
      if (!Array.isArray(value)) fail(field, 'not_list');
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(field, 'too_many', { limit: schema.maxItems, value: value.length });
      // A plain item's limit names the list (filters.tags too_long {limit}, contract §9); an object item keeps its index.
      value.forEach((v, i) => check(schema.items, v, schema.items.type === 'object' ? `${field}[${i}]` : field));
      return;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field || 'request', 'not_object');
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!Object.hasOwn(schema.properties, key)) unknownField(field, key);
      }
      for (const key of schema.required ?? []) {
        if (own(obj, key) === undefined) fail(field ? `${field}.${key}` : key, 'required');
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (own(obj, key) !== undefined) check(sub, own(obj, key), field ? `${field}.${key}` : key);
      }
    }
  }
}

// A field is read only from the request's own properties, never through an inherited name (contract §2).
function own(obj: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// A copy holding only the schema's own fields, so nothing past the check can reach an inherited or extra one.
function ownCopy(schema: Schema, value: unknown): unknown {
  if (schema.type === 'array' && Array.isArray(value)) return value.map((v) => ownCopy(schema.items, v));
  if (schema.type === 'object' && value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = Object.create(null);
    for (const [key, sub] of Object.entries(schema.properties)) {
      const v = own(value as Record<string, unknown>, key);
      if (v !== undefined) out[key] = ownCopy(sub, v);
    }
    return out;
  }
  return value;
}

// Checks a request against its operation's schema as `face` sees it where the catalog runs (the MCP face has no
// CLI-only input; a hosted catalog takes the hosted forms); throws
// invalid_request naming the field (and the limit, if any). Returns a copy of the request with only its own, known fields.
export function validateInput<T>(op: keyof typeof OPERATIONS | OperationDef, input: unknown, face: Face, where: Where): T {
  const def = typeof op === 'string' ? OPERATIONS[op]! : op;
  // No face of a local catalog offers a hosted-only operation, so reaching one here is a bug.
  if (def.where === 'hosted' && where !== 'hosted') throw new Error(`${def.name} is hosted only: a local catalog never serves it`);
  const schema = inputSchema(def, face, where);
  check(schema, input ?? {}, '');
  return ownCopy(schema, input ?? {}) as T;
}
