// The system map's readers (qa/src/map/imports.ts, aws.ts): what uses what in the code, and what the AWS stack is
// made of, read from the files themselves. Checked against facts a person can verify by opening the files.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { accessWords, readAws, templateFromSnapshot } from '../src/map/aws.ts';
import { ROOT } from '../src/map/build.ts';
import { PACKAGES, readFacts } from '../src/map/facts.ts';
import { readImports, type ImportGraph } from '../src/map/imports.ts';
import { scratch } from './machine.ts';

describe('the import graph', () => {
  let g: ImportGraph;
  beforeAll(() => { g = readImports(ROOT, PACKAGES, readFacts(ROOT).sources); });
  const has = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);

  it('follows relative imports', () => {
    expect(has('client/src/mcp/server.ts', 'client/src/operations.ts')).toMatchObject({ types: false });
  });
  it('follows a package\'s own name to the file that defines what is imported, through its index file', () => {
    // client/src/mcp/server.ts: import { Words } from '@skills-catalog/core'; core/src/index.ts re-exports it from words-file.ts.
    expect(has('client/src/mcp/server.ts', 'core/src/words-file.ts')).toBeTruthy();
    expect(has('client/src/mcp/server.ts', 'core/src/index.ts')).toBeUndefined();
    // A subpath export: @skills-catalog/core/skill-tree is core/src/skill-tree/index.ts and what it re-exports.
    expect(g.edges.some((e) => e.from.startsWith('client/src/') && e.to.startsWith('core/src/skill-tree/'))).toBe(true);
  });
  it('marks imports of types only', () => {
    // client/src/mcp/server.ts: import type { Settings } from '../settings.ts'
    expect(has('client/src/mcp/server.ts', 'client/src/settings.ts')).toMatchObject({ types: true });
  });
  it('counts dynamic imports', () => {
    expect(has('client/src/main.ts', 'client/src/cli/setup.ts')).toMatchObject({ types: false });
  });
  it('leaves out what isn\'t the system\'s (node:, libraries)', () => {
    expect(g.edges.every((e) => g.files.includes(e.from) && g.files.includes(e.to))).toBe(true);
  });
  it('reads every form an import takes, one statement at a time', () => {
    const root = scratch('map-imports-');
    const write = (p: string, text: string) => { mkdirSync(join(root, p, '..'), { recursive: true }); writeFileSync(join(root, p), text); };
    write('a/package.json', JSON.stringify({ name: '@x/a', exports: { '.': './src/index.ts' } }));
    write('a/src/index.ts', "export * from './one.ts';\nexport { two as deux } from './two.ts';\nexport type { Two } from './two.ts';\n");
    write('a/src/one.ts', 'export const one = 1;\nexport function helper() {}\n');
    write('a/src/two.ts', 'export type Two = 2;\nexport const two = 2;\n');
    write('a/src/use.ts', [
      "import { one } from '@x/a';",
      "import { deux, type Two } from './index.ts';",
      "export const z = 3; // a statement with no from: never runs on into the next",
      "import './side.ts';",
      'const later = await import(\'./late.ts\');',
    ].join('\n'));
    write('a/src/side.ts', '');
    write('a/src/late.ts', 'export const late = 1;\n');
    const files = ['a/src/index.ts', 'a/src/one.ts', 'a/src/two.ts', 'a/src/use.ts', 'a/src/side.ts', 'a/src/late.ts'];
    const x = readImports(root, ['a'], files);
    const from = (f: string) => x.edges.filter((e) => e.from === f).map((e) => `${e.to}${e.types ? ' (types)' : ''}`);
    expect(from('a/src/use.ts')).toEqual(['a/src/late.ts', 'a/src/one.ts', 'a/src/side.ts', 'a/src/two.ts']);
    expect(from('a/src/index.ts')).toEqual(['a/src/one.ts', 'a/src/two.ts']);
  });
});

describe('the AWS stack, from the template infra pins', () => {
  const aws = readAws(ROOT);
  const id = (prefix: string) => aws.resources.find((r) => r.id.startsWith(prefix))!.id;

  it('reads every resource with its type', () => {
    expect(aws.resources.length).toBeGreaterThan(30);
    expect(aws.resources.find((r) => r.id.startsWith('StorageTable'))?.type).toBe('AWS::DynamoDB::Table');
    expect(aws.resources.find((r) => r.id.startsWith('ApiHandler'))?.type).toBe('AWS::Lambda::Function');
  });
  it('reads which resource names which', () => {
    expect(aws.refs).toContainEqual({ from: id('SiteEdge0'), to: id('ApiHttp1'), allows: false }); // CloudFront's origin is the HTTP API
    expect(aws.refs).toContainEqual({ from: id('EventsPipe'), to: id('StorageTable'), allows: false }); // the pipe reads the table's stream
    // The pages bucket's policy names CloudFront to let it read: that grants, it doesn't use.
    expect(aws.refs).toContainEqual({ from: id('SitePagesPolicy'), to: id('SiteEdge0'), allows: true });
  });
  it('reads what a function may do, through its role', () => {
    const api = aws.access.find((a) => a.from === id('ApiHandler') && a.to === id('StorageTable'))!;
    expect(accessWords(api.actions)).toBe('reads, writes');
    const sweep = aws.access.find((a) => a.from === id('SweepHandler') && a.to === id('StorageTable'))!;
    expect(accessWords(sweep.actions)).toBe('reads');
  });
  it('reads both presets the snapshot pins, and refuses one it doesn\'t', () => {
    expect(readAws(ROOT, 'throwaway').resources.length).toBeGreaterThan(30);
    expect(() => templateFromSnapshot('', 'demo')).toThrow(/no "demo" template/);
  });
});
