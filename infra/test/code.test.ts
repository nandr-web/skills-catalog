// The stack's own code: the hosted package's three function entries, bundled by the local esbuild as a deploy bundles
// them. The API reads its words file from beside its bundle, so the API's asset (and only it) carries core's words file,
// byte for byte; each bundle loads and exports its handler without running anything.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';
import { CATALOG_CODE } from '../src/code.ts';
import { PRESETS } from '../src/config.ts';
import { CatalogStack } from '../src/stack.ts';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const WORDS = join(repo, 'core', 'words', 'words.yaml');

describe("the stack's code", () => {
  it("is the hosted package's three entries, each exporting its handler", async () => {
    expect([CATALOG_CODE.api, CATALOG_CODE.indexer, CATALOG_CODE.sweep]).toEqual(['api', 'indexer', 'sweep'].map((n) => join(repo, 'hosted', 'src', 'entries', `${n}.ts`)));
    for (const entry of [CATALOG_CODE.api, CATALOG_CODE.indexer, CATALOG_CODE.sweep]) {
      expect(existsSync(entry), entry).toBe(true);
      expect(typeof (await import(pathToFileURL(entry).href)).handler, entry).toBe('function');
    }
  });

  describe('bundled as a deploy bundles it', () => {
    const outdir = mkdtempSync(join(tmpdir(), 'catalog-synth-'));
    afterAll(() => rmSync(outdir, { recursive: true, force: true }));
    const app = new App({ outdir });
    const stack = new CatalogStack(app, 'skills-catalog-throwaway', PRESETS.throwaway, CATALOG_CODE);
    app.synth();
    const t = Template.fromStack(stack);
    /** Each function's asset folder, by the function's logical id prefix. */
    const asset = (prefix: string) => {
      const [, f] = Object.entries(t.findResources('AWS::Lambda::Function')).find(([id]) => id.startsWith(prefix))!;
      const key = (f as any).Properties.Code.S3Key as string;
      return join(outdir, `asset.${key.replace(/\.zip$/, '')}`);
    };

    it("the API's asset has core's words file beside its bundle, byte for byte; the indexer's and the sweep's have none", () => {
      expect(readFileSync(join(asset('ApiHandler'), 'words.yaml'))).toEqual(readFileSync(WORDS));
      for (const fn of ['IndexerHandler', 'SweepHandler']) expect(readdirSync(asset(fn)), fn).not.toContain('words.yaml');
    });

    it('each bundle loads and exports its handler, running nothing until it is called', async () => {
      for (const fn of ['ApiHandler', 'IndexerHandler', 'SweepHandler']) {
        const files = readdirSync(asset(fn));
        const main = files.find((f) => /^index\.m?js$/.test(f))!;
        expect(main, fn).toBeDefined();
        expect(typeof (await import(pathToFileURL(join(asset(fn), main)).href)).handler, fn).toBe('function');
      }
    });
  });
});
