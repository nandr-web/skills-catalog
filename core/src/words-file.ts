// Every word an assistant sees, rendered from the vendored words.yaml (one variant: `recommended` unless told
// otherwise). Tool names in prose are written ${op} and filled from the variant's names; result fields are {field}
// and must all be filled: a missing field is a bug here, never a "{field}" shown to an agent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { OPERATIONS, inputSchema, type OperationDef, type Schema } from './api.ts';

export const WORDS_FILE = join(import.meta.dirname, '..', 'words', 'words.yaml');

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchema;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  maxItems?: number;
}

export interface ToolDef {
  name: string;
  op: string;
  description: string;
  inputSchema: JsonSchema & { type: 'object' };
  annotations: Record<string, unknown>;
}

export class UnfilledError extends Error {}

export class Words {
  readonly doc: any;
  readonly variant: string;
  readonly v: Record<string, any>;
  readonly names: Record<string, string>;
  readonly cli: string;
  readonly page: number;
  readonly guided: boolean;
  readonly words: any;

  constructor(doc: any, variant: string = doc.recommended) {
    if (!doc.variants?.[variant]) throw new Error(`the words file has no variant ${variant}; it has ${Object.keys(doc.variants ?? {}).join(', ')}`);
    this.doc = doc;
    this.variant = variant;
    this.v = doc.variants[variant];
    this.names = doc.names[this.v['names']];
    this.cli = this.v['cli'] ?? doc.cli ?? 'skills-catalog';
    this.page = Number(this.v['page']);
    this.guided = this.v['results'] === 'guided';
    this.words = this.fill(doc.results);
  }

  static load(variant?: string, file = WORDS_FILE): Words {
    const doc = parse(readFileSync(file, 'utf8'));
    return new Words(doc, variant ?? doc.recommended);
  }

  // ${op} → this variant's tool name; ${cli} → the command. Unknown ${…} are left for the test to catch.
  fill<T>(obj: T): T {
    if (typeof obj === 'string') {
      const map: Record<string, string> = { ...this.names, cli: this.cli };
      return obj.replace(/\$\{(\w+)\}/g, (m, k: string) => map[k] ?? m) as T;
    }
    if (Array.isArray(obj)) return obj.map((x) => this.fill(x)) as T;
    if (obj && typeof obj === 'object') return Object.fromEntries(Object.entries(obj).map(([k, x]) => [k, this.fill(x)])) as T;
    return obj;
  }

  // {field} → fields[field]. Every placeholder must have a value.
  format(template: string, fields: Record<string, unknown> = {}): string {
    return template.replace(/\{(\w+)\}/g, (_, k: string) => {
      if (!(k in fields) || fields[k] === undefined || fields[k] === null) throw new UnfilledError(`no value for {${k}} in: ${template.slice(0, 80)}`);
      return String(fields[k]);
    });
  }

  // The words at a dotted path under results (e.g. "errors.not_found"), or undefined when the words file has none.
  word(path: string): any {
    return path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), this.words);
  }

  get serverName(): string {
    return this.doc.server.name;
  }

  get instructions(): string | null {
    const text = this.doc.server.instructions[this.v['instructions']];
    return text ? this.fill(text) : null;
  }

  // The MCP tools: every API operation that has one. Types, required fields and limits come from the API
  // (one schema per operation, contract §1), without the inputs only a person at the CLI gives; the words file gives only
  // the names and the words.
  toolDefs(operations: Record<string, OperationDef> = OPERATIONS): ToolDef[] {
    return Object.values(operations)
      .filter((op) => op.faces.includes('mcp') && op.words && this.doc.tools[op.words])
      .map((op) => {
        const spec = this.doc.tools[op.words!];
        const input = inputSchema(op, 'mcp', 'local');
        return {
          name: this.names[op.words!]!,
          op: op.name,
          description: this.fill(spec.description[this.v['descriptions']]),
          inputSchema: this.jsonSchema(input, { properties: spec.params ?? {} }) as ToolDef['inputSchema'],
          annotations: spec.annotations ?? {},
        };
      });
  }

  // An API schema as JSON Schema, with each property's description from the words for it.
  private jsonSchema(schema: Schema, words: any): JsonSchema {
    const level = this.v['descriptions'];
    const out: JsonSchema = { type: schema.type };
    if (words?.[level] !== undefined) out.description = this.fill(String(words[level]).replace('{page}', String(this.page)));
    switch (schema.type) {
      case 'string':
        if (schema.enum) out.enum = schema.enum;
        if (schema.maxLength !== undefined) out.maxLength = schema.maxLength;
        break;
      case 'integer':
        if (schema.minimum !== undefined) out.minimum = schema.minimum;
        if (schema.maximum !== undefined) out.maximum = schema.maximum;
        break;
      case 'array':
        out.items = this.jsonSchema(schema.items, undefined);
        if (schema.maxItems !== undefined) out.maxItems = schema.maxItems;
        break;
      case 'object':
        out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, sub]) => [k, this.jsonSchema(sub, words?.properties?.[k])]));
        out.required = [...(schema.required ?? [])];
        out.additionalProperties = false;
        break;
    }
    return out;
  }

  companionSkill(kind: 'mcp' | 'cli'): string {
    return this.fill(this.doc.companion_skill[kind]);
  }
}
