// One registry of operations (contract §1): each is defined once, with a typed input schema, and the faces (CLI, MCP,
// later HTTP) are generated from it. Slice 1 holds the catalog operations; the machine operations join in slice 2.

import { CatalogError } from './errors.ts';

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
  input: Extract<Schema, { type: 'object' }>;
}

// Request limits are errors that name the field and the limit, never silent clamps (contract §9).
export const MAX_SEARCH_LIMIT = 50;
export const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_READ_NAMES = 20;
export const VERSIONS_PAGE = 50;

const name = { type: 'string', maxLength: 200 } as const;
const version = { type: 'integer', minimum: 1 } as const;

export const OPERATIONS: Record<string, OperationDef> = {
  search_shared_skills: {
    name: 'search_shared_skills',
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
            tags: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 20 },
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
      },
    },
  },
  list_shared_skill_versions: {
    name: 'list_shared_skill_versions',
    kind: 'catalog',
    phase: 1,
    mcp: true,
    input: { type: 'object', properties: { name, cursor: { type: 'string', maxLength: 200 } }, required: ['name'] },
  },
  diff_shared_skill_versions: {
    name: 'diff_shared_skill_versions',
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
};

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
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(field, 'too_many_items', { limit: schema.maxItems, value: value.length });
      value.forEach((v, i) => check(schema.items, v, `${field}[${i}]`));
      return;
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(field || 'request', 'not_object');
      const obj = value as Record<string, unknown>;
      for (const key of Object.keys(obj)) {
        if (!Object.hasOwn(schema.properties, key)) fail(field ? `${field}.${key}` : key, 'unknown_field');
      }
      for (const key of schema.required ?? []) {
        if (obj[key] === undefined) fail(field ? `${field}.${key}` : key, 'required');
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (obj[key] !== undefined) check(sub, obj[key], field ? `${field}.${key}` : key);
      }
    }
  }
}

// Checks a request against its operation's schema; throws invalid_request naming the field (and the limit, if any).
export function validateInput<T>(op: keyof typeof OPERATIONS, input: unknown): T {
  check(OPERATIONS[op]!.input, input ?? {}, '');
  return (input ?? {}) as T;
}
