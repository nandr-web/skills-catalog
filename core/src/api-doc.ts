// The API page's reference section (docs/api.md): every operation as its definition says it, written between two
// markers by `npm run api-doc`, so the page can't drift from the code; a test fails when the checked-in page is out of
// date. The rest of the page (its narrative, examples and picture) is written by hand and never touched here.

import { OPERATIONS, inputSchema, type Face, type OperationDef, type OutputSchema, type Schema } from './api.ts';
import { COMMON_ERRORS } from './errors.ts';

export const API_DOC_START = '<!-- The reference below is written by `npm run api-doc` in core/, from the operations\' definitions. Don\'t edit it by hand. -->';
export const API_DOC_END = '<!-- End of the written reference. -->';

const FACES: Record<Face, string> = { mcp: 'the Assistant\'s tool', cli: 'the CLI', web: 'HTTP' };
const EFFECTS: Record<OperationDef['effect'], string> = {
  reads: 'changes nothing',
  writes_catalog: 'changes the catalog',
  writes_machine: 'changes this machine\'s installed skills',
};

const code = (s: string) => `\`${s}\``;
const indent = (depth: number) => '  '.repeat(depth);
const n = (x: number) => x.toLocaleString('en-US');

// An input's type and limits in words: what a request may send, as the request check reads it.
function inputType(s: Schema): string {
  switch (s.type) {
    case 'string': {
      const parts = [s.enum ? `one of ${s.enum.map(code).join(', ')}` : 'text'];
      if (s.minLength !== undefined) parts.push(`at least ${n(s.minLength)} characters`);
      if (s.maxLength !== undefined) parts.push(`at most ${n(s.maxLength)} characters`);
      return parts.join(', ');
    }
    case 'integer':
      if (s.minimum !== undefined && s.maximum !== undefined) return `a whole number from ${n(s.minimum)} to ${n(s.maximum)}`;
      if (s.minimum !== undefined) return `a whole number, at least ${n(s.minimum)}`;
      if (s.maximum !== undefined) return `a whole number, at most ${n(s.maximum)}`;
      return 'a whole number';
    case 'boolean':
      return 'true or false';
    case 'array': {
      const size = s.maxItems !== undefined ? ` of at most ${n(s.maxItems)}` : '';
      return `a list${size}, each ${s.items.type === 'object' ? 'with' : inputType(s.items)}`;
    }
    case 'object':
      return 'an object with';
  }
}

function inputLines(schema: Extract<Schema, { type: 'object' }>, depth: number, cliOnly: readonly string[] = []): string[] {
  const lines: string[] = [];
  for (const [field, s] of Object.entries(schema.properties)) {
    const notes = [(schema.required ?? []).includes(field) ? 'required' : 'optional'];
    if (cliOnly.includes(field)) notes.push('CLI only: a person\'s own choice, never taken from the Assistant\'s tool or HTTP');
    lines.push(`${indent(depth)}- ${code(field)}: ${inputType(s)} (${notes.join('; ')})`);
    const inner = s.type === 'array' ? s.items : s;
    if (inner.type === 'object') lines.push(...inputLines(inner, depth + 1));
  }
  return lines;
}

// An output's shape in words; an object's fields and a choice's forms go on the lines below it.
function outputType(s: OutputSchema): string {
  if ('anyOf' in s) return 'one of these';
  if (!('type' in s)) return 'any value';
  switch (s.type) {
    case 'string':
      return s.enum ? `one of ${s.enum.map(code).join(', ')}` : 'text';
    case 'integer':
      return 'a whole number';
    case 'boolean':
      return 'true or false';
    case 'null':
      return code('null');
    case 'array':
      return `a list, each ${outputType(s.items)}`;
    case 'object':
      return Object.keys(s.properties).length ? 'an object with' : 'an object';
  }
}

function outputLines(s: OutputSchema, depth: number): string[] {
  if ('anyOf' in s) return s.anyOf.flatMap((form) => [`${indent(depth)}- ${outputType(form)}`, ...outputLines(form, depth + 1)]);
  if (!('type' in s)) return [];
  if (s.type === 'array') return outputLines(s.items, depth);
  if (s.type !== 'object') return [];
  return Object.entries(s.properties).flatMap(([field, sub]) => [
    `${indent(depth)}- ${code(field)}: ${outputType(sub)}${s.required.includes(field) ? '' : ' (not always there)'}`,
    ...outputLines(sub, depth + 1),
  ]);
}

// One operation's part of the reference.
export function operationPart(def: OperationDef): string {
  const lines = [
    `### ${code(def.name)}`,
    '',
    `Served by ${def.where === 'hosted' ? 'hosted catalogs only' : 'local and hosted catalogs'}. ` +
      `Called through ${def.faces.map((f) => `${FACES[f]} (${code(f)})`).join(', ')}. ` +
      `It ${EFFECTS[def.effect]} (${code(def.effect)}).`,
    '',
    '**Input**',
    '',
  ];
  const input = inputSchema(def, 'cli', 'local');
  lines.push(...(Object.keys(input.properties).length ? inputLines(input, 0, def.cliOnly) : ['- nothing']));
  if (def.hostedForm) {
    lines.push('', '**Hosted, instead** (each form refuses the other)', '');
    lines.push(...inputLines({ type: 'object', properties: def.hostedForm, required: def.input.required }, 0));
  }
  lines.push('', '**Output**', '');
  if (def.output === 'text') lines.push('- text, for the person to read');
  else lines.push(`- ${outputType(def.output)}`, ...outputLines(def.output, 1));
  const own = def.errors.length ? `${def.errors.map(code).join(', ')}; and, like every call, ` : 'only those every call can return: ';
  lines.push('', `**Errors:** ${own}${COMMON_ERRORS.map(code).join(', ')}`);
  return lines.join('\n');
}

// Every operation, in the definitions' order.
export function apiReference(): string {
  return (Object.values(OPERATIONS) as OperationDef[]).map(operationPart).join('\n\n') + '\n';
}

// The page with its reference section written anew; everything outside the markers stays as it is.
export function withReference(page: string): string {
  const start = page.indexOf(API_DOC_START);
  const end = page.indexOf(API_DOC_END);
  if (start < 0 || end < start) throw new Error('the page has no reference markers: add API_DOC_START and API_DOC_END (core/src/api-doc.ts) where the reference goes');
  return `${page.slice(0, start + API_DOC_START.length)}\n\n${apiReference()}\n${page.slice(end)}`;
}
