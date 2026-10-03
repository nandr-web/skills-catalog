// The repo's one output-schema checker, shared by the API's tests and the web API's shared cases.
import type { OutputSchema } from '../src/api.ts';

// An output schema, checked by the JSON Schema rule (an object takes other fields unless additionalProperties says no);
// the schemas close every object, so a field the code adds or drops fails here before it reaches the published schema.
export function conforms(schema: OutputSchema, value: unknown, at = '$'): string[] {
  if ('anyOf' in schema) {
    const each = schema.anyOf.map((s) => conforms(s, value, at));
    return each.some((e) => e.length === 0) ? [] : [`${at}: matches none of ${schema.anyOf.length}: ${each.map((e) => e[0]).join(' | ')}`];
  }
  if (!('type' in schema)) return []; // any value (a front matter value, a flag's from/to)
  switch (schema.type) {
    case 'null':
      return value === null ? [] : [`${at}: not null`];
    case 'string':
      if (typeof value !== 'string') return [`${at}: not a string`];
      return schema.enum && !schema.enum.includes(value) ? [`${at}: ${value} not one of ${schema.enum.join(', ')}`] : [];
    case 'integer':
      return Number.isInteger(value) ? [] : [`${at}: not an integer`];
    case 'number':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [`${at}: not a number`];
    case 'boolean':
      return typeof value === 'boolean' ? [] : [`${at}: not a boolean`];
    case 'array':
      return Array.isArray(value) ? value.flatMap((v, i) => conforms(schema.items, v, `${at}[${i}]`)) : [`${at}: not an array`];
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${at}: not an object`];
      const o = value as Record<string, unknown>;
      const errs = schema.required.filter((k) => !(k in o)).map((k) => `${at}.${k}: missing`);
      for (const [k, v] of Object.entries(o)) {
        const p = schema.properties[k];
        if (p) errs.push(...conforms(p, v, `${at}.${k}`));
        else if (schema.additionalProperties === false) errs.push(`${at}.${k}: not in the schema`);
        else if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) errs.push(...conforms(schema.additionalProperties, v, `${at}.${k}`));
      }
      return errs;
    }
  }
}
