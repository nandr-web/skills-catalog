// The published schema (contract §1.1): OpenAPI 3.1, generated from the operations' definitions, one route per
// operation served on the web face. `npm run schema` writes it to docs/api/openapi.json; a test fails when that file
// is out of date.

import { OPERATIONS, inputSchema, type OperationDef, type OutputSchema, type Schema } from './api.ts';
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
            description: 'The error\'s code and its data (contract §9).',
            properties: { code: { type: 'string', enum: ERROR_CODES.filter((c) => own.has(c)) } },
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

const GUARDS = { '401': ref('responses', 'NoToken'), '403': ref('responses', 'Refused'), '404': ref('responses', 'NotFound'), '415': ref('responses', 'NotJson') };
const SECURITY = [{ localToken: [] }];

function operation(def: OperationDef): Json {
  return {
    operationId: def.name,
    'x-effect': def.effect,
    'x-faces': [...def.faces],
    'x-errors': [...def.errors],
    security: SECURITY,
    parameters: [ref('parameters', 'ActingAs')],
    requestBody: { required: true, content: { 'application/json': { schema: ref('schemas', `${def.name}_input`) } } },
    responses: {
      '200': { description: 'The operation\'s answer, error or not.', content: { 'application/json': { schema: ref('schemas', `${def.name}_envelope`) } } },
      ...GUARDS,
    },
  };
}

export function openapi(): Json {
  const web = Object.values(OPERATIONS).filter((d) => d.faces.includes('web'));
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
    schemas[`${def.name}_input`] = strict(inputSchema(def, 'web'));
    schemas[`${def.name}_output`] = def.output as OutputSchema;
    schemas[`${def.name}_envelope`] = envelope(def);
    paths[`${API_PATH}/${def.name}`] = { post: operation(def) };
  }
  paths[`${API_PATH}/files/{sha256}`] = {
    get: {
      operationId: 'fetch_file',
      description: 'One file of a stored version, by its sha256; a version\'s files never change.',
      'x-effect': 'reads',
      'x-faces': ['web'],
      security: SECURITY,
      parameters: [{ name: 'sha256', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }],
      responses: {
        '200': { description: 'The file\'s bytes (a local catalog).', content: { 'application/octet-stream': {} } },
        '302': {
          description: 'A short-lived link to the file\'s bytes, issued after the caller\'s check (a hosted catalog).',
          headers: { Location: { schema: { type: 'string' } }, 'Cache-Control': { schema: { type: 'string', const: 'no-store' } } },
        },
        '503': {
          description: 'Uploaded for a publish that hasn\'t finished: try again shortly.',
          headers: { 'Retry-After': { schema: { type: 'integer' } } },
        },
        '404': ref('responses', 'NotFound'),
        '401': ref('responses', 'NoToken'),
        '403': ref('responses', 'Refused'),
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'skills-catalog',
      version: API_VERSION,
      description: 'The catalog\'s operations over HTTP, generated from the same definitions as the assistant\'s tools and the CLI.',
    },
    'x-error-codes': [...ERROR_CODES],
    'x-common-errors': [...COMMON_ERRORS],
    paths,
    components: {
      schemas,
      parameters: {
        ActingAs: {
          name: 'X-Skills-Catalog-As',
          in: 'header',
          required: false,
          description: 'The developer to act as, on a local catalog only (a body field would be refused); a hosted catalog refuses it and takes who is asking from the sign-in.',
          schema: { type: 'string', maxLength: 200 },
        },
      },
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
  };
}

export function openapiJson(): string {
  return `${JSON.stringify(openapi(), null, 2)}\n`;
}
