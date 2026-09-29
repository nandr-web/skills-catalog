// cdk-nag's AwsSolutions pack on both presets: no finding left standing, and every one the stack answers instead of
// fixing is acknowledged on the construct it concerns (never the whole stack), with its own reason.

import { App } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { describe, expect, it } from 'vitest';
import { PRESETS, type PresetName } from '../src/config.ts';
import { NAG_ANSWERS } from '../src/nag.ts';
import { CatalogStack } from '../src/stack.ts';
import { FIXTURE_CODE, TEST_RUNTIME_VERSION } from './synth.ts';

function stack(preset: PresetName) {
  const app = new App();
  const given = preset === 'demo' ? { runtimeVersionArn: TEST_RUNTIME_VERSION } : {};
  return new CatalogStack(app, `skills-catalog-${preset}`, { ...PRESETS[preset], ...given }, FIXTURE_CODE);
}

for (const preset of ['throwaway', 'demo'] as const) {
  describe(`cdk-nag AwsSolutions [${preset}]`, () => {
    const s = stack(preset);
    const report = new AwsSolutionsChecks().validateScope(s);

    it('no finding is left standing', () => {
      const standing = report.violations.flatMap((v) => v.violatingResources.map((r) => `${v.ruleName} ${r.constructPath ?? r.resourceLogicalId}`));
      expect(standing).toEqual([]);
    });
  });
}

describe("the stack's answers to cdk-nag", () => {
  it('each is on a construct inside the stack, never the stack itself, with a reason of its own', () => {
    expect(NAG_ANSWERS.length).toBeGreaterThan(0);
    for (const a of NAG_ANSWERS) {
      expect(a.path, a.id).not.toBe('');
      expect(a.reason.length, a.id).toBeGreaterThanOrEqual(30);
    }
    expect(new Set(NAG_ANSWERS.map((a) => `${a.path} ${a.id}`)).size).toBe(NAG_ANSWERS.length);
  });

  it('each answer finds its construct in both presets (a moved construct fails here, not silently)', () => {
    for (const preset of ['throwaway', 'demo'] as const) {
      const s = stack(preset);
      for (const a of NAG_ANSWERS.filter((x) => !x.presets || x.presets.includes(preset))) expect(s.node.tryFindChild(a.path.split('/')[0]!), `${preset} ${a.path}`).toBeDefined();
    }
  });
});
