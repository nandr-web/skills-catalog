// A stack synthesized in process for its template: never deployed, no account looked up. The functions' entries are
// stand-ins (test/fixtures), bundled by the local esbuild like the real ones.
import { fileURLToPath } from 'node:url';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CatalogStack } from '../src/stack.ts';
import { PRESETS, type PresetName, type StageConfig } from '../src/config.ts';

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));
export const FIXTURE_CODE = { api: fixture('api'), indexer: fixture('indexer'), sweep: fixture('sweep'), projectRoot: fileURLToPath(new URL('..', import.meta.url)) };

export function synth(preset: PresetName, change: Partial<StageConfig> = {}): Template {
  const app = new App();
  return Template.fromStack(new CatalogStack(app, `skills-catalog-${preset}`, { ...PRESETS[preset], ...change }, FIXTURE_CODE));
}
