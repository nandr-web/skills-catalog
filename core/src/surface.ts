// Every word an assistant sees, rendered from the vendored surface.yaml (one variant: `recommended` unless told
// otherwise). Tool names in prose are written ${op} and filled from the variant's names; result fields are {field}
// and must all be filled: a missing field is a bug here, never a "{field}" shown to an agent.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export const SURFACE_FILE = join(import.meta.dirname, '..', 'surface', 'surface.yaml');

export interface ToolDef {
  name: string;
  op: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
  annotations: Record<string, unknown>;
}

// Which parameters each tool requires (the rest are optional).
const REQUIRED: Record<string, string[]> = {
  search: [],
  get: [],
  status: [],
  update: [],
  versions: ['name'],
  diff: ['name', 'from', 'to'],
  install: ['name'],
  policy: ['policy'],
  publish: ['folder'],
  accept: ['name', 'confirm'],
};

export class UnfilledError extends Error {}

export class Surface {
  readonly doc: any;
  readonly variant: string;
  readonly v: Record<string, any>;
  readonly names: Record<string, string>;
  readonly cli: string;
  readonly page: number;
  readonly guided: boolean;
  readonly words: any;

  constructor(doc: any, variant: string = doc.recommended) {
    if (!doc.variants?.[variant]) throw new Error(`surface has no variant ${variant}; it has ${Object.keys(doc.variants ?? {}).join(', ')}`);
    this.doc = doc;
    this.variant = variant;
    this.v = doc.variants[variant];
    this.names = doc.names[this.v['names']];
    this.cli = this.v['cli'] ?? doc.cli ?? 'skills-catalog';
    this.page = Number(this.v['page']);
    this.guided = this.v['results'] === 'guided';
    this.words = this.fill(doc.results);
  }

  static load(variant?: string, file = SURFACE_FILE): Surface {
    const doc = parse(readFileSync(file, 'utf8'));
    return new Surface(doc, variant ?? doc.recommended);
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

  // The words at a dotted path under results (e.g. "errors.not_found"), or undefined when the surface has none.
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

  toolDefs(): ToolDef[] {
    const level = this.v['descriptions'];
    return Object.entries<any>(this.doc.tools).map(([op, spec]) => {
      const properties: Record<string, unknown> = {};
      for (const [p, ps] of Object.entries<any>(spec.params ?? {})) {
        const prop: Record<string, unknown> = { type: ps.type, description: this.fill(String(ps[level]).replace('{page}', String(this.page))) };
        if (ps.items) prop['items'] = { type: ps.items };
        if (ps.enum) prop['enum'] = ps.enum;
        properties[p] = prop;
      }
      return {
        name: this.names[op]!,
        op,
        description: this.fill(spec.description[level]),
        inputSchema: { type: 'object', properties, required: REQUIRED[op] ?? [] },
        annotations: spec.annotations ?? {},
      };
    });
  }

  companionSkill(kind: 'mcp' | 'cli'): string {
    return this.fill(this.doc.companion_skill[kind]);
  }
}
