// cdk-nag's AwsSolutions pack on both presets: no error or warning left standing, and every one the stack answers
// instead of fixing is suppressed where it arises, with its reason, never for the whole stack.

import { App, Aspects } from 'aws-cdk-lib';
import { Annotations, Match } from 'aws-cdk-lib/assertions';
import { AwsSolutionsChecks, NagPackSuppression } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { PRESETS, type PresetName } from '../src/config.ts';
import { NAG_ANSWERS } from '../src/nag.ts';
import { CatalogStack } from '../src/stack.ts';
import { FIXTURE_CODE, TEST_RUNTIME_VERSION } from './synth.ts';

function checked(preset: PresetName) {
  const app = new App();
  const given = preset === 'demo' ? { runtimeVersionArn: TEST_RUNTIME_VERSION } : {};
  const stack = new CatalogStack(app, `skills-catalog-${preset}`, { ...PRESETS[preset], ...given }, FIXTURE_CODE);
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
  app.synth();
  return { stack, annotations: Annotations.fromStack(stack) };
}

for (const preset of ['throwaway', 'demo'] as const) {
  describe(`cdk-nag AwsSolutions [${preset}]`, () => {
    const { stack, annotations } = checked(preset);
    const text = (ms: { entry: { data: unknown }; id: string }[]) => ms.map((m) => `${m.id}: ${String(m.entry.data).split('\n')[0]}`);

    it('no error is left standing', () => {
      expect(text(annotations.findError('*', Match.stringLikeRegexp('AwsSolutions-.*')))).toEqual([]);
    });

    it('no warning is left standing', () => {
      expect(text(annotations.findWarning('*', Match.stringLikeRegexp('AwsSolutions-.*')))).toEqual([]);
    });

    it('nothing is suppressed for the whole stack; each answer has a reason of its own', () => {
      expect(stack.node.metadata.filter((m) => m.type === 'cdk_nag')).toEqual([]);
      expect(NAG_ANSWERS.length).toBeGreaterThan(0);
      for (const a of NAG_ANSWERS as NagPackSuppression[]) expect(a.reason.length, a.id).toBeGreaterThanOrEqual(30);
      expect(new Set(NAG_ANSWERS.map((a) => a.reason)).size).toBe(NAG_ANSWERS.length);
    });
  });
}
