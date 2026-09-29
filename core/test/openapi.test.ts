// The published schemas (contract §1.1): docs/api/openapi.local.json (what serve runs) and openapi.hosted.json, both
// generated from the operations' definitions, checked in, and failing here when out of date. No OpenAPI tooling is used: the structure is checked by hand below, and real
// results, wrapped in the envelope, are checked against it with a small JSON Schema reader.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, inputSchema } from '../src/api.ts';
import { COMMON_ERRORS, ERROR_CODES } from '../src/errors.ts';
import { actAs } from '../src/local/index.ts';
import { API_VERSION, openapi, openapiJson } from '../src/openapi.ts';
import { historyVersion, loadGolden } from './golden.ts';
import { errorOf, openTest, request } from './helpers.ts';

const histories = loadGolden('histories.yaml');
const WHERE = ['local', 'hosted'] as const;
const FILE = (where: string) => join(import.meta.dirname, '..', '..', 'docs', 'api', `openapi.${where}.json`);
const webRows = Object.values(OPERATIONS).filter((d) => d.faces.includes('web') && d.where === undefined);

type Json = Record<string, any>;
const doc = openapi('local') as Json;
const hostedDoc = openapi('hosted') as Json;

function resolve(ref: string, d: Json = doc): Json {
  expect(ref.startsWith('#/')).toBe(true);
  let node: any = d;
  for (const part of ref.slice(2).split('/')) node = node?.[part];
  expect(node, `${ref} resolves`).toBeTypeOf('object');
  return node;
}
const deref = (s: Json, d: Json = doc): Json => (s.$ref ? resolve(s.$ref, d) : s);

describe('the published schema is the definitions\' (contract §1.1)', () => {
  it('the checked-in files are what `npm run schema` writes now', () => {
    for (const where of WHERE) {
      const onDisk = readFileSync(FILE(where), 'utf8');
      expect(onDisk === openapiJson(where), `docs/api/openapi.${where}.json is out of date: run \`npm run schema\` in core/`).toBe(true);
      expect(JSON.parse(onDisk)).toEqual(openapi(where));
    }
  });

  it('each is OpenAPI 3.1, version 1.0.0, with the error list as data', () => {
    expect(API_VERSION).toBe('1.0.0');
    for (const d of [doc, hostedDoc]) {
      expect(d.openapi).toBe('3.1.0');
      expect(d.info.version).toBe(API_VERSION);
      expect(d.info.title).toBe('skills-catalog');
      expect(d.components.schemas.ErrorCode).toEqual({ type: 'string', enum: [...ERROR_CODES] });
      expect(d['x-error-codes']).toEqual([...ERROR_CODES]);
      expect(d['x-common-errors']).toEqual([...COMMON_ERRORS]);
    }
    expect(doc['x-where']).toBe('local');
    expect(hostedDoc['x-where']).toBe('hosted');
  });

  it('has one POST /api/v1/<name> per web-faced operation, and the files route; nothing else', () => {
    expect(webRows.map((d) => d.name).sort()).toEqual(['diff_shared_skill_versions', 'fetch_version', 'list_shared_skill_versions', 'publish_version', 'read_shared_skill', 'search_shared_skills']);
    expect(Object.keys(doc.paths).sort()).toEqual([...webRows.map((d) => `/api/v1/${d.name}`), '/api/v1/files/{sha256}'].sort());
    for (const d of webRows) expect([d.name, Object.keys(doc.paths[`/api/v1/${d.name}`])]).toEqual([d.name, ['post']]);
    const ids = Object.values(doc.paths).flatMap((p: any) => Object.values(p).map((o: any) => o.operationId));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('each operation carries its row: input as the web face sees it, effect, faces, errors, the local security', () => {
    for (const d of webRows) {
      const op = doc.paths[`/api/v1/${d.name}`].post;
      expect([d.name, op.operationId, op['x-effect'], op['x-faces'], op['x-errors']]).toEqual([d.name, d.name, d.effect, [...d.faces], [...d.errors]]);
      expect(op.security).toEqual([{ localToken: [] }]);
      expect(op.parameters.map((s: Json) => deref(s)).map((p: Json) => [p.in, p.name, p.required])).toEqual([['header', 'X-Skills-Catalog-As', false]]);
      expect(op.requestBody.required).toBe(true);
      expect(Object.keys(op.requestBody.content)).toEqual(['application/json']);
      const input = deref(op.requestBody.content['application/json'].schema);
      expect(input).toEqual(strict(inputSchema(d, 'web', 'local')));
      for (const k of d.cliOnly ?? []) expect([d.name, k in input.properties]).toEqual([d.name, false]);
      expect(Object.keys(op.responses).sort()).toEqual(['200', '401', '403', '404', '415']);
    }
    expect(doc.components.securitySchemes).toEqual({ localToken: expect.objectContaining({ type: 'apiKey', in: 'header', name: 'X-Skills-Catalog-Token' }) });
  });

  it('hosted, each operation takes a bearer token and no acting header, as the hosted form of its input sees it', () => {
    for (const d of Object.values(OPERATIONS).filter((o) => o.faces.includes('web'))) {
      const op = hostedDoc.paths[`/api/v1/${d.name}`].post;
      expect([d.name, op.security, op.parameters]).toEqual([d.name, [{ bearer: [] }], undefined]);
      expect(deref(op.requestBody.content['application/json'].schema, hostedDoc)).toEqual(strict(inputSchema(d, 'web', 'hosted')));
      expect([d.name, Object.keys(op.responses).sort()]).toEqual([d.name, ['200', '401', '404', '415']]);
    }
    expect(hostedDoc.components.securitySchemes).toEqual({ bearer: expect.objectContaining({ type: 'http', scheme: 'bearer' }) });
    expect(hostedDoc.components.parameters).toBeUndefined();
  });

  it('each answer is the envelope: {ok: true, data} with the output schema, or {ok: false, error} with its codes, and words beside', () => {
    for (const d of webRows) {
      const env = deref(doc.paths[`/api/v1/${d.name}`].post.responses['200'].content['application/json'].schema);
      const [ok, err] = env.oneOf.map((s: Json) => deref(s));
      expect(ok.properties.ok).toEqual({ const: true });
      expect(deref(ok.properties.data)).toEqual(d.output);
      expect(ok.required).toEqual(['ok', 'data']);
      expect(err.properties.ok).toEqual({ const: false });
      expect(err.required).toEqual(['ok', 'error']);
      const codes: string[] = err.properties.error.properties.code.enum;
      expect(new Set(codes)).toEqual(new Set([...d.errors, ...COMMON_ERRORS]));
      expect(codes).toEqual(ERROR_CODES.filter((c) => codes.includes(c))); // in §9's order
      for (const s of [ok, err]) expect(deref(s.properties.words)).toBe(doc.components.schemas.Words);
    }
    expect(Object.keys(doc.components.schemas.Words.properties)).toEqual(['error', 'acting_as', 'demo', 'verdict']);
    expect(doc.components.schemas.Words.additionalProperties).toBe(false);
  });

  it('the files route: a 64-hex sha256; locally the bytes, hosted a link or on its way; else a 404; behind each one\'s security', () => {
    for (const d of [doc, hostedDoc]) {
      const get = d.paths['/api/v1/files/{sha256}'].get;
      expect(Object.keys(d.paths['/api/v1/files/{sha256}'])).toEqual(['get']);
      expect(get.parameters).toEqual([{ name: 'sha256', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-f]{64}$' } }]);
      expect([get['x-effect'], get['x-faces']]).toEqual(['reads', ['web']]);
    }
    const local = doc.paths['/api/v1/files/{sha256}'].get;
    expect(Object.keys(local.responses).sort()).toEqual(['200', '401', '403', '404']);
    expect(Object.keys(local.responses['200'].content)).toEqual(['application/octet-stream']);
    expect(local.security).toEqual([{ localToken: [] }]);
    const hosted = hostedDoc.paths['/api/v1/files/{sha256}'].get;
    expect(Object.keys(hosted.responses).sort()).toEqual(['302', '401', '404', '503']);
    expect(Object.keys(hosted.responses['302'].headers).sort()).toEqual(['Cache-Control', 'Location']);
    expect(Object.keys(hosted.responses['503'].headers)).toEqual(['Retry-After']);
    expect(hosted.security).toEqual([{ bearer: [] }]);
  });

  it.each(WHERE)('%s is well formed: every $ref resolves, every component is used, every schema uses known words only and every object says whether it takes other fields', (where) => {
    const d = where === 'local' ? doc : hostedDoc;
    const used = new Set<string>();
    const problems: string[] = [];
    const walk = (node: unknown, at: string, inSchema: boolean): void => {
      if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${at}[${i}]`, inSchema));
      if (!node || typeof node !== 'object') return;
      const n = node as Json;
      if (typeof n.$ref === 'string') {
        used.add(n.$ref);
        resolve(n.$ref, d);
        if (Object.keys(n).length !== 1) problems.push(`${at}: $ref with siblings`);
        return;
      }
      if (inSchema) problems.push(...schemaProblems(n, at));
      for (const [k, v] of Object.entries(n)) {
        const childIsSchema = inSchema ? SCHEMA_CHILDREN.has(k) : k === 'schema' || at.endsWith('.components.schemas');
        if (inSchema && k === 'properties') for (const [pk, pv] of Object.entries(v as Json)) walk(pv, `${at}.properties.${pk}`, true);
        else if (inSchema && (k === 'enum' || k === 'required' || k === 'const')) continue;
        else walk(v, `${at}.${k}`, childIsSchema);
      }
    };
    walk(d, '$', false);
    expect(problems).toEqual([]);
    // ErrorCode is the whole list (§9) for a client to take as a type; each operation's own codes are narrower.
    const unused = ['#/components/schemas/ErrorCode'];
    for (const kind of ['schemas', 'parameters', 'responses'] as const) {
      for (const key of Object.keys(d.components[kind] ?? {})) {
        const at = `#/components/${kind}/${key}`;
        expect([at, used.has(at)]).toEqual([at, !unused.includes(at)]);
      }
    }
    // and the walker itself finds what it's for
    expect(schemaProblems({ type: 'object', properties: {}, required: ['x'], additionalProperties: false }, '$')).toEqual(['$: required x is not a property']);
    expect(schemaProblems({ type: 'object', properties: {} }, '$')).toEqual(['$: an object that doesn\'t say whether it takes other fields']);
    expect(schemaProblems({ type: 'date' }, '$')).toEqual(['$: unknown type date']);
    expect(schemaProblems({ type: 'string', maxLen: 3 }, '$')).toEqual(['$: unknown keyword maxLen']);
  });
});

describe('real answers fit the published schema (contract §1.1)', () => {
  it('every web operation\'s real result and a real error, wrapped in the envelope, fit its response; the wrong ones don\'t', async () => {
    const { catalog } = await openTest();
    const v = (ref: string) => historyVersion(histories.versions[ref]);
    const words = { acting_as: 'Acting as dev1.' };
    const ok = async (op: string, call: () => Promise<unknown>) => [op, { ok: true, data: JSON.parse(JSON.stringify(await call())), words }] as const;
    const answers = [
      await ok('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v1'), { message: 'first' }), actAs('dev1'))),
      await ok('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v3')), actAs('dev1'))),
      await ok('search_shared_skills', () => catalog.search({ query: 'review checklist' })),
      await ok('read_shared_skill', () => catalog.read({ names: ['pr-review-checklist', 'no-such-skill'], include: 'contents' })),
      await ok('list_shared_skill_versions', () => catalog.versions({ name: 'pr-review-checklist' })),
      await ok('diff_shared_skill_versions', () => catalog.diff({ name: 'pr-review-checklist', from: 1, to: 2 })),
      await ok('fetch_version', () => catalog.fetch({ name: 'pr-review-checklist', version: 2 })),
    ];
    const notFound = await errorOf(() => catalog.versions({ name: 'no-such-skill' }));
    const invalid = await errorOf(() => catalog.search({ limit: 999 }));
    catalog.close();
    const failed = { ok: false, error: JSON.parse(JSON.stringify(notFound)), words: { error: 'No shared skill is named no-such-skill.' } };
    const refused = { ok: false, error: JSON.parse(JSON.stringify(invalid)) };
    const response = (op: string) => doc.paths[`/api/v1/${op}`].post.responses['200'].content['application/json'].schema;

    for (const [op, answer] of answers) expect([op, errorsOf(response(op), answer)]).toEqual([op, []]);
    expect(new Set(answers.map(([op]) => op))).toEqual(new Set(webRows.map((d) => d.name)));
    expect(errorsOf(response('list_shared_skill_versions'), failed)).toEqual([]);
    expect(errorsOf(response('search_shared_skills'), refused)).toEqual([]);
    // what must not fit: another operation's data, a code the operation can't raise, a word that isn't a sentence, no ok
    const fetched = answers.find(([op]) => op === 'fetch_version')![1];
    expect(errorsOf(response('search_shared_skills'), fetched)).not.toEqual([]);
    expect(errorsOf(response('search_shared_skills'), { ...failed, error: { code: 'lock_busy' } })).not.toEqual([]);
    expect(errorsOf(response('fetch_version'), { ...fetched, words: { demo: 3 } })).not.toEqual([]);
    expect(errorsOf(response('fetch_version'), { ...fetched, words: { other: 'x' } })).not.toEqual([]);
    expect(errorsOf(response('fetch_version'), { ...fetched, data: { ...fetched.data, extra: 1 } })).not.toEqual([]);
    expect(errorsOf(response('fetch_version'), { data: fetched.data })).not.toEqual([]);
  });
});

// An input schema as JSON Schema: the check refuses a field it doesn't list, so every object says so.
function strict(s: any): any {
  if (s.type === 'object') {
    const properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, strict(v)]));
    return { ...s, properties, additionalProperties: false };
  }
  if (s.type === 'array') return { ...s, items: strict(s.items) };
  return s;
}

const KEYWORDS = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'anyOf', 'oneOf', 'maxLength', 'minLength', 'minimum', 'maximum', 'maxItems', 'pattern', 'description']);
const SCHEMA_CHILDREN = new Set(['items', 'additionalProperties', 'anyOf', 'oneOf']);
const TYPES = new Set(['object', 'array', 'string', 'integer', 'boolean', 'null']);

function schemaProblems(s: Json, at: string): string[] {
  const out: string[] = [];
  for (const k of Object.keys(s)) if (!KEYWORDS.has(k)) out.push(`${at}: unknown keyword ${k}`);
  if (s.type !== undefined && !TYPES.has(s.type)) out.push(`${at}: unknown type ${s.type}`);
  for (const r of s.required ?? []) if (!s.properties || !(r in s.properties)) out.push(`${at}: required ${r} is not a property`);
  // Strict by the standard: JSON Schema leaves an object open unless it says otherwise.
  if (s.type === 'object' && s.additionalProperties === undefined) out.push(`${at}: an object that doesn't say whether it takes other fields`);
  return out;
}

// A small JSON Schema reader for the words the schema uses, by the standard's rules (an object with no
// additionalProperties is open; the structural test makes every object say).
function errorsOf(schema: Json, value: unknown, at = '$'): string[] {
  const s = deref(schema);
  if (s.oneOf) {
    const fits = s.oneOf.filter((o: Json) => errorsOf(o, value, at).length === 0).length;
    return fits === 1 ? [] : [`${at}: fits ${fits} of oneOf`];
  }
  if (s.anyOf) return s.anyOf.some((o: Json) => errorsOf(o, value, at).length === 0) ? [] : [`${at}: fits none of anyOf`];
  if ('const' in s && value !== s.const) return [`${at}: not ${s.const}`];
  if (s.enum && !s.enum.includes(value)) return [`${at}: ${String(value)} not in the enum`];
  switch (s.type) {
    case undefined:
      return [];
    case 'null':
      return value === null ? [] : [`${at}: not null`];
    case 'string':
      return typeof value === 'string' ? [] : [`${at}: not a string`];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at}: not an integer`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: not a boolean`];
    case 'array':
      return Array.isArray(value) ? value.flatMap((v, i) => errorsOf(s.items, v, `${at}[${i}]`)) : [`${at}: not an array`];
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: not an object`];
      const o = value as Json;
      const errs: string[] = (s.required ?? []).filter((k: string) => !(k in o)).map((k: string) => `${at}.${k}: missing`);
      for (const [k, v] of Object.entries(o)) {
        if (s.properties?.[k]) errs.push(...errorsOf(s.properties[k], v, `${at}.${k}`));
        else if (s.additionalProperties === false) errs.push(`${at}.${k}: not allowed`);
        else if (s.additionalProperties && s.additionalProperties !== true) errs.push(...errorsOf(s.additionalProperties, v, `${at}.${k}`));
      }
      return errs;
    }
  }
  return [`${at}: unknown type ${s.type}`];
}
