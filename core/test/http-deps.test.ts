// core/src/http is the web API's transport-free half: the local `serve` and the hosted handler both import it, so it
// holds no transport, no disk, no process and nothing of the client (contract §1.1). The rule is checked on its own
// files' direct imports only: the core modules it uses (catalog.ts, the skill tree) read their data files when they're
// loaded, which a hosted bundle carries anyway, so a transitive rule couldn't hold and wouldn't say more. `import type`
// is allowed (it's gone at run time).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = new URL('../src/http/', import.meta.url).pathname;
const FORBIDDEN = [/^node:/, /^(fs|http|https|http2|net|tls|dgram|child_process|worker_threads|cluster)(\/|$)/, /\/local(\/|\.ts$)/, /\/config(\.ts)?$/, /(^|\/)client(\/|$)/, /^@skills-catalog\/client/, /\/internal-error\.ts$/];

/** Each runtime import of a file: `import … from 'x'`, `export … from 'x'`, `import 'x'` and `import('x')`, but not `import type`. */
export function runtimeImports(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(/^\s*(import|export)\s+(type\s+)?([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm)) if (!m[2]) specs.push(m[4]!);
  for (const m of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specs.push(m[1]!);
  for (const m of source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]!);
  return specs;
}

describe('core/src/http imports no transport, disk, process or client', () => {
  it('reads what an import looks like', () => {
    expect(runtimeImports("import { a } from 'node:fs';\nimport type { B } from '../local/x.ts';\nexport { c } from './c.ts';\nimport 'node:net';\nconst x = import('node:http');")).toEqual(['node:fs', './c.ts', 'node:net', 'node:http']);
  });

  it('holds for every file in it', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const broken = files.flatMap((f) => runtimeImports(readFileSync(join(DIR, f), 'utf8')).filter((s) => FORBIDDEN.some((re) => re.test(s))).map((s) => `${f}: ${s}`));
    expect(broken).toEqual([]);
  });
});
