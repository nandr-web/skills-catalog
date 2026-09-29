// The API (contract §1): each operation is defined once, with a typed input schema, and the faces (CLI, MCP,
// later HTTP) are generated from it. Slice 1 holds the catalog operations; the machine operations join in slice 2.

import { CatalogError } from './errors.ts';
import { MAX_TAGS, TAG_MAX_LENGTH } from './skill-tree/index.ts';

export type Schema =
  | { type: 'string'; enum?: readonly string[]; maxLength?: number; minLength?: number }
  | { type: 'integer'; minimum?: number; maximum?: number }
  | { type: 'boolean' }
  | { type: 'array'; items: Schema; maxItems?: number }
  | { type: 'object'; properties: Record<string, Schema>; required?: readonly string[] };

export interface OperationDef {
  name: string;
  kind: 'catalog' | 'machine';
  phase: 1 | 2 | 'aws' | 'later';
  mcp: boolean;
  words?: string; // its key in the words file (the tool's words), for operations with an MCP tool
  input: Extract<Schema, { type: 'object' }>;
  // Inputs only a person at the CLI gives (contract §3): never in the MCP schema, and refused from the MCP face.
  cliOnly?: readonly string[];
}

export type Face = 'mcp' | 'cli';

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

export const OPERATIONS: Record<string, OperationDef> = {
  search_shared_skills: {
    name: 'search_shared_skills',
    words: 'search',
    kind: 'catalog',
    phase: 1,
    mcp: true,
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
    mcp: true,
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
    mcp: true,
    input: { type: 'object', properties: { name, cursor: { type: 'string', maxLength: 200 } }, required: ['name'] },
  },
  diff_shared_skill_versions: {
    name: 'diff_shared_skill_versions',
    words: 'diff',
    kind: 'catalog',
    phase: 1,
    mcp: true,
    input: { type: 'object', properties: { name, from: version, to: version }, required: ['name', 'from', 'to'] },
  },
  publish_version: {
    name: 'publish_version',
    kind: 'catalog',
    phase: 1,
    mcp: false,
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
  },
  fetch_version: {
    name: 'fetch_version',
    kind: 'catalog',
    phase: 1,
    mcp: false,
    input: { type: 'object', properties: { name, version, fingerprint: { type: 'string', maxLength: 80 } } },
  },

  // Machine operations (contract §3): they run in the client, on this machine; the CLI and the MCP server are their faces.
  publish_skill_to_catalog: {
    name: 'publish_skill_to_catalog',
    words: 'publish',
    kind: 'machine',
    phase: 1,
    mcp: true,
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
    mcp: true,
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
    mcp: true,
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
    mcp: true,
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
    mcp: true,
    input: { type: 'object', properties: {} },
  },
  set_skill_update_policy: {
    name: 'set_skill_update_policy',
    words: 'policy',
    kind: 'machine',
    phase: 1,
    mcp: true,
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
