// The API (contract §1): each operation is defined once, with a typed input schema, and the faces (CLI, MCP,
// later HTTP) are generated from it. Slice 1 holds the catalog operations; the machine operations join in slice 2.

import { CatalogError, ERROR_CODES, type ErrorCode } from './errors.ts';
import { MAX_TAGS, MODES, TAG_MAX_LENGTH } from './skill-tree/index.ts';

export type Schema =
  | { type: 'string'; enum?: readonly string[]; maxLength?: number; minLength?: number }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: Schema; maxItems?: number }
  | { type: 'object'; properties: Record<string, Schema>; required?: readonly string[] };

// An operation's result as JSON Schema (OpenAPI 3.1 takes it as it is): an object lists every field it has, the
// optional ones left out of `required`; `{}` is any value (a front matter value, a flag's old and new values).
export type OutputSchema =
  | { type: 'string'; enum?: readonly string[] }
  | { type: 'integer' }
  | { type: 'boolean' }
  | { type: 'null' }
  | { type: 'array'; items: OutputSchema }
  | { type: 'object'; properties: Record<string, OutputSchema>; required: readonly string[]; additionalProperties?: boolean | OutputSchema }
  | { anyOf: readonly OutputSchema[] }
  | Record<string, never>;

// The faces an operation can be served on (contract §1): the assistant's tools, the CLI, the web page (HTTP, §1.1).
export type Face = 'mcp' | 'cli' | 'web';

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
const obj = (properties: Record<string, OutputSchema>, optional: readonly string[] = []): OutputSchema => ({
  type: 'object',
  properties,
  required: Object.keys(properties).filter((k) => !optional.includes(k)),
});
const riskFlag = obj({ kind: oneOf(...FLAG_KINDS), path: str, line: int, field: str, from: anyValue, to: anyValue, detail: str }, ['path', 'line', 'field', 'from', 'to']);
const treeDiff = {
  files: list(obj({ path: str, status: oneOf('added', 'changed', 'removed'), flags: obj({ binary: bool, executable: bool, script: bool }), unified: str }, ['unified'])),
  frontmatter_changes: list(obj({ field: str, from: anyValue, to: anyValue })),
  publisher_changed: bool,
  risk_flags: list(riskFlag),
};
const mode = oneOf(...MODES);
const SEARCH_OUTPUT = obj(
  {
    results: list(obj({ name: str, description: str, latest_version: int, tags: list(str), publisher: str, matched_words: list(str) })),
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
    reviews: list(anyValue),
    files: list(obj({ path: str, mode, size: int, sha256: str, type: oneOf('text', 'binary'), content: str, content_omitted: bool }, ['content', 'content_omitted'])),
  },
  ['files'],
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
          maxItems: 10_000,
        },
        message: { type: 'string', maxLength: 1000 },
        expected_latest: { type: 'integer', minimum: 0 },
        dry_run: { type: 'boolean' },
        allow_suspected_secrets: { type: 'boolean' }, // a person's override, per publish; never in an MCP schema
      },
      required: ['name', 'files'],
    },
    cliOnly: ['allow_suspected_secrets'],
  },
  fetch_version: {
    name: 'fetch_version',
    kind: 'catalog',
    phase: 1,
    faces: ['web'],
    effect: 'reads',
    run: 'fetch',
    output: FETCH_OUTPUT,
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

// An operation's input schema as one face sees it: the MCP face never gets the CLI-only inputs.
// No default face: a caller that forgets it must not get the CLI's inputs.
export function inputSchema(op: string | OperationDef, face: Face): OperationDef['input'] {
  const def = typeof op === 'string' ? OPERATIONS[op]! : op;
  if (face === 'cli' || !def.cliOnly?.length) return def.input;
  const properties = Object.fromEntries(Object.entries(def.input.properties).filter(([k]) => !def.cliOnly!.includes(k)));
  return { ...def.input, properties };
}

function fail(field: string, why: string, extra: Record<string, unknown> = {}): never {
  throw new CatalogError('invalid_request', { field, why, ...extra });
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
        if (!Object.hasOwn(schema.properties, key)) fail(field ? `${field}.${key}` : key, 'unknown_field');
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

// Checks a request against its operation's schema as `face` sees it (the MCP face has no CLI-only input); throws
// invalid_request naming the field (and the limit, if any). Returns a copy of the request with only its own, known fields.
export function validateInput<T>(op: keyof typeof OPERATIONS, input: unknown, face: Face): T {
  const schema = inputSchema(op, face);
  check(schema, input ?? {}, '');
  return ownCopy(schema, input ?? {}) as T;
}
