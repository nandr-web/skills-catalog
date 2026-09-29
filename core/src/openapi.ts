// The published schemas (contract §1.1): OpenAPI 3.1, generated from the operations' definitions, one route per
// operation served on the web face, one schema for each place the catalog runs. `npm run schema` writes them to
// docs/api/openapi.local.json and openapi.hosted.json; a test fails when either is out of date.

import { OPERATIONS, inputSchema, webRow, type OperationDef, type OutputSchema, type Schema, type Where } from './api.ts';
import { COMMON_ERRORS, ERROR_CODES } from './errors.ts';

// v1 in the path; a new operation, optional input or output field raises the minor version, a removal or a change of
// meaning the major version and a new path (§1.1).
export const API_VERSION = '1.0.0';
export const API_PATH = '/api/v1';

type Json = Record<string, unknown>;

const ref = (kind: 'schemas' | 'parameters' | 'responses', name: string) => ({ $ref: `#/components/${kind}/${name}` });

// An input schema as JSON Schema: the request check refuses any field it doesn't list, so every object says so.
function strict(s: Schema): Json {
  if (s.type === 'object') {
    const properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strict(v)]));
    return { ...s, properties, additionalProperties: false };
  }
  if (s.type === 'array') return { ...s, items: strict(s.items) };
  return { ...s };
}

// The envelope (§1.1): status codes mean the guards only; the operation's answer, error or not, is 200 with one of these.
function envelope(def: OperationDef): Json {
  const own = new Set<string>([...def.errors, ...COMMON_ERRORS]);
  return {
    oneOf: [
      {
        type: 'object',
        properties: { ok: { const: true }, data: ref('schemas', `${def.name}_output`), words: ref('schemas', 'Words') },
        required: ['ok', 'data'],
        additionalProperties: false,
      },
      {
        type: 'object',
        properties: {
          ok: { const: false },
          error: {
            type: 'object',
            description:
              'The error\'s code and its data (contract §9). An invalid_request naming an unknown key longer than 200 characters names its first 200 and carries field_cut: true.',
            properties: {
              code: { type: 'string', enum: ERROR_CODES.filter((c) => own.has(c)) },
              field_cut: { type: 'boolean', description: 'The field names only the first 200 characters of an unknown key.' },
            },
            required: ['code'],
            additionalProperties: true, // each code's own fields
          },
          words: ref('schemas', 'Words'),
        },
        required: ['ok', 'error'],
        additionalProperties: false,
      },
    ],
  };
}

// What each place's server checks before an operation runs, and how a caller says who it is (§1.1): locally the
// session token from pairing, the Host and Origin, and the acting developer in a header; hosted a bearer token only.
const PLACE = {
  local: {
    security: [{ localToken: [] }],
    guards: { '401': ref('responses', 'NoToken'), '403': ref('responses', 'Refused'), '404': ref('responses', 'NotFound'), '415': ref('responses', 'NotJson') },
    parameters: { ActingAs: {
      name: 'X-Skills-Catalog-As',
      in: 'header',
      required: false,
      description: 'The developer to act as (a body field would be refused), one setup knows.',
      schema: { type: 'string', maxLength: 200 },
    } },
    responses: {
      NoToken: { description: 'The session token is missing or wrong.' },
      Refused: { description: 'The Host or Origin isn\'t this server\'s own.' },
      NotFound: { description: 'No such operation or file.' },
      NotJson: { description: 'The body isn\'t application/json.' },
    },
    securitySchemes: {
      localToken: { type: 'apiKey', in: 'header', name: 'X-Skills-Catalog-Token', description: 'The local server\'s session token, from pairing; compared in constant time.' },
    },
  },
  hosted: {
    security: [{ bearer: [] }],
    guards: {
      '400': ref('responses', 'TokenOnly'),
      '401': ref('responses', 'NoToken'),
      '403': ref('responses', 'Refused'),
      '404': ref('responses', 'NotFound'),
      '415': ref('responses', 'NotJson'),
    },
    parameters: undefined,
    responses: {
      TokenOnly: {
        description: 'The local acting header was sent: who is asking comes only from the token here (not 401: the token may be fine).',
        content: { 'application/json': { schema: {
          type: 'object',
          properties: {
            ok: { const: false },
            error: {
              type: 'object',
              properties: { code: { const: 'invalid_request' }, field: { const: 'X-Skills-Catalog-As' }, why: { const: 'token_only' } },
              required: ['code', 'field', 'why'],
              additionalProperties: false,
            },
            words: ref('schemas', 'Words'),
          },
          required: ['ok', 'error'],
          additionalProperties: false,
        } } },
      },
      NoToken: { description: 'The bearer token is missing, expired or wrong.' },
      Refused: { description: 'Refused before the API.' },
      NotFound: { description: 'No such operation or file.' },
      NotJson: { description: 'The body isn\'t application/json.' },
    },
    securitySchemes: {
      bearer: { type: 'http', scheme: 'bearer', description: 'A session from signing in, or a personal token (read or publish scope); who is asking comes only from it.' },
    },
  },
} as const;

function operation(def: OperationDef, where: Where): Json {
  const place = PLACE[where];
  return {
    operationId: def.name,
    'x-effect': def.effect,
    'x-faces': [...def.faces],
    'x-errors': [...def.errors],
    security: place.security,
    ...(place.parameters ? { parameters: [ref('parameters', 'ActingAs')] } : {}),
    requestBody: { required: true, content: { 'application/json': { schema: ref('schemas', `${def.name}_input`) } } },
    responses: {
      '200': { description: 'The operation\'s answer, error or not.', content: { 'application/json': { schema: ref('schemas', `${def.name}_envelope`) } } },
      ...place.guards,
    },
  };
}

// A stored version's file (§1.1): locally its bytes; hosted a short-lived link, or on its way seconds after a publish.
function fileRoute(where: Where): Json {
  const found: Json =
    where === 'local'
      ? { '200': { description: 'The file\'s bytes.', content: { 'application/octet-stream': {} } } }
      : {
          '302': {
            description: 'A short-lived link to the file\'s bytes, issued after the caller\'s check.',
            headers: { Location: { schema: { type: 'string' } }, 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } },
          },
          '503': {
            description: 'Uploaded for a publish that hasn\'t finished: try again shortly.',
            headers: { 'Retry-After': { schema: { type: 'integer', const: 2 } } },
          },
        };
  const { '415': _json, ...guards } = PLACE[where].guards as Json;
  return {
    get: {
      operationId: 'fetch_file',
      description: 'One file of a stored version, by its sha256; a version\'s files never change.',
      'x-effect': 'reads',
      'x-faces': ['web'],
      security: PLACE[where].security,
      parameters: [{ name: 'sha256', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }],
      responses: { ...found, ...guards },
    },
  };
}

// The schema of the catalog's HTTP API where it runs: its operations served on the web face there (a hosted-only one
// only hosted), each input as that place takes it.
export function openapi(where: Where, ops: Record<string, OperationDef> = OPERATIONS): Json {
  const web = Object.values(ops).filter((d) => webRow(d, where));
  const schemas: Json = {
    ErrorCode: { type: 'string', enum: [...ERROR_CODES] },
    Words: {
      type: 'object',
      description: 'The sentences the other faces show for the same answer, beside the data or the error.',
      properties: { error: { type: 'string' }, acting_as: { type: 'string' }, demo: { type: 'string' }, verdict: { type: 'string' } },
      additionalProperties: false,
    },
  };
  const paths: Json = {};
  for (const def of web) {
    schemas[`${def.name}_input`] = strict(inputSchema(def, 'web', where));
    schemas[`${def.name}_output`] = (where === 'hosted' && def.hostedOutput) || (def.output as OutputSchema);
    schemas[`${def.name}_envelope`] = envelope(def);
    paths[`${API_PATH}/${def.name}`] = { post: operation(def, where) };
  }
  paths[`${API_PATH}/files/{sha256}`] = fileRoute(where);
  const place = PLACE[where];
  return {
    openapi: '3.1.0',
    info: {
      title: 'skills-catalog',
      version: API_VERSION,
      description: `The catalog's operations over HTTP on a ${where} catalog, generated from the same definitions as the assistant's tools and the CLI.`,
    },
    'x-where': where,
    'x-error-codes': [...ERROR_CODES],
    'x-common-errors': [...COMMON_ERRORS],
    paths,
    components: {
      schemas,
      ...(place.parameters ? { parameters: place.parameters } : {}),
      responses: place.responses,
      securitySchemes: place.securitySchemes,
    },
  };
}

export function openapiJson(where: Where): string {
  return `${JSON.stringify(openapi(where), null, 2)}\n`;
}
