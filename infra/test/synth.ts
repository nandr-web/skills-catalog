// A stack synthesized in process for its template: never deployed, no account looked up.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CatalogStack } from '../src/stack.ts';
import { PRESETS, type PresetName } from '../src/config.ts';

export function synth(preset: PresetName): Template {
  const app = new App();
  return Template.fromStack(new CatalogStack(app, `skills-catalog-${preset}`, PRESETS[preset]));
}
