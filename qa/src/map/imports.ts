// What uses what in the code, read from the source files themselves (no compiler, so the same files always give the
// same graph): every import and re-export between the system's files. A name imported through an index file that
// re-exports it (`export { x } from './x.ts'`, `export * from …`) counts as an import of the file that defines it, so
// the graph says which file really uses which. Imports from outside the system's packages (node:, aws-sdk) are left out.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

/** `from` imports something `to` defines (both relative to the repo, with / between folders). `types`: only types,
 *  which shape the code but never run (`import type`, or every name marked `type`). */
export type ImportEdge = { from: string; to: string; types: boolean };
export type ImportGraph = { files: string[]; edges: ImportEdge[] };

/** One import or re-export statement: the names it takes (`*` for all, `default`) and where from. */
type Name = { imported: string; exported: string; types: boolean };
type Clause = { names: Name[] | '*'; spec: string; reexport: boolean; types: boolean };

// The clause between import/export and from: `{ … }`, `* as ns`, `x`, or `x, { … }` / `x, * as ns`. Written out, so a
// match can't run on from one statement into the next.
const STATEMENT = /^[ \t]*(import|export)\s+(type\s+)?(\{[^}]*\}|\*(?:\s+as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s*from\s*['"]([^'"]+)['"]/gm;
const BARE = /^[ \t]*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;
const LOCAL = /^[ \t]*export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\*?|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gm;
const LOCAL_LIST = /^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}\s*;?[ \t]*$/gm;

/** The names in `{ a, b as c, type d }` or `* as ns` or `x, { a }`; `types` when the whole clause is `type`. */
function names(clause: string, types: boolean): Clause['names'] {
  if (/^\*(\s+as\s+\w+)?$/.test(clause.trim())) return '*';
  const out: Name[] = [];
  const braces = clause.match(/\{([^}]*)\}/);
  const before = (braces ? clause.slice(0, braces.index) : clause).replace(/,\s*$/, '').trim();
  if (before && !before.startsWith('{')) {
    if (before.startsWith('*')) return '*';
    out.push({ imported: 'default', exported: before, types });
  }
  for (const part of (braces?.[1] ?? '').split(',')) {
    const t = part.trim();
    const m = t.replace(/^type\s+/, '').match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    if (m) out.push({ imported: m[1]!, exported: m[2] ?? m[1]!, types: types || t.startsWith('type ') });
  }
  return out;
}

function clauses(text: string): Clause[] {
  const out: Clause[] = [];
  for (const m of text.matchAll(STATEMENT)) out.push({ names: names(m[3]!, !!m[2]), spec: m[4]!, reexport: m[1] === 'export', types: !!m[2] });
  for (const m of text.matchAll(BARE)) out.push({ names: '*', spec: m[1]!, reexport: false, types: false });
  for (const m of text.matchAll(DYNAMIC)) out.push({ names: '*', spec: m[1]!, reexport: false, types: false });
  return out;
}

/** The names a file defines itself (not the ones it re-exports from elsewhere). */
function localNames(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(LOCAL)) out.add(m[1]!);
  if (/^[ \t]*export\s+default\b/m.test(text)) out.add('default');
  for (const m of text.matchAll(LOCAL_LIST)) for (const part of m[1]!.split(',')) {
    const x = part.trim().replace(/^type\s+/, '').match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
    if (x) out.add(x[2] ?? x[1]!);
  }
  return out;
}

const isFile = (p: string) => existsSync(p) && statSync(p).isFile();

/**
 * Reads the import graph of every `.ts` file under `<package>/src` for the given packages. A package's own name (from
 * its package.json, with its `exports` map) resolves like a relative path, so `@skills-catalog/core/skill-tree` is a
 * file of core like any other.
 */
export function readImports(root: string, packages: readonly string[], sources: readonly string[]): ImportGraph {
  const files = sources.filter((f) => f.endsWith('.ts')).sort();
  const known = new Set(files);
  const text = new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));

  // The packages' own names: "@skills-catalog/core" + its exports ("." and "./skill-tree") → a file in the repo.
  const named = new Map<string, string>();
  for (const p of packages) {
    const pj = join(root, p, 'package.json');
    if (!isFile(pj)) continue;
    const { name, exports } = JSON.parse(readFileSync(pj, 'utf8')) as { name?: string; exports?: Record<string, string> | string };
    if (!name) continue;
    const map = typeof exports === 'string' ? { '.': exports } : exports ?? {};
    for (const [sub, target] of Object.entries(map)) if (typeof target === 'string')
      named.set(sub === '.' ? name : `${name}/${sub.replace(/^\.\//, '')}`, posix.normalize(posix.join(p, target)));
  }

  /** The repo file a specifier in `from` names, or undefined when it's outside the system (node:, a library). */
  const resolve = (from: string, spec: string): string | undefined => {
    const base = spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(from), spec)) : named.get(spec);
    if (!base) return undefined;
    for (const c of [base, `${base}.ts`, posix.join(base, 'index.ts'), base.replace(/\.js$/, '.ts')]) if (known.has(c)) return c;
    return undefined;
  };

  const parsed = new Map(files.map((f) => [f, clauses(text.get(f)!)]));
  const locals = new Map(files.map((f) => [f, localNames(text.get(f)!)]));

  /** The file that defines `name` as `file` exports it: itself, or where a re-export chain leads. */
  const definer = (file: string, name: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(file)) return undefined;
    seen.add(file);
    if (locals.get(file)?.has(name)) return file;
    for (const c of parsed.get(file) ?? []) {
      if (!c.reexport) continue;
      const target = resolve(file, c.spec);
      if (!target) continue;
      if (c.names === '*') { const d = definer(target, name, seen); if (d) return d; continue; }
      const hit = c.names.find((n) => n.exported === name);
      if (hit) return definer(target, hit.imported, seen) ?? target;
    }
    return undefined;
  };

  // One edge per pair of files: types only when every import between them is.
  const edges = new Map<string, ImportEdge>();
  const add = (from: string, to: string, types: boolean) => {
    if (from === to) return;
    const k = `${from}\0${to}`, had = edges.get(k);
    edges.set(k, { from, to, types: had ? had.types && types : types });
  };
  for (const f of files) for (const c of parsed.get(f)!) {
    const target = resolve(f, c.spec);
    if (!target) continue;
    if (c.names === '*') { add(f, target, c.types); continue; }
    for (const n of c.names) add(f, definer(target, n.imported) ?? target, n.types);
  }
  return { files, edges: [...edges.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)) };
}
