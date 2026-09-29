// The deploy kit (slice 4, print-only): the CDK app's settings for a real account, refused for the placeholder one, and
// the deploy plan, which prints what would be made, what it may cost and every command in order, and runs nothing.
import { readFileSync } from 'node:fs';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { buildApp, deployConfig } from '../src/app.ts';
import { ACCOUNT } from '../src/config.ts';
import { CDK_CLI, deployPlan } from '../src/deploy-plan.ts';
import { FIXTURE_CODE, TEST_RUNTIME_VERSION } from './synth.ts';

const REAL = '123456789012';

describe('the app for a real deploy', () => {
  it('refuses the placeholder account, and an account that is not 12 digits', () => {
    expect(() => deployConfig({ preset: 'throwaway', account: ACCOUNT })).toThrow(/placeholder/);
    expect(() => deployConfig({ preset: 'throwaway', account: '12345' })).toThrow(/12 digits/);
    expect(() => deployConfig({ preset: 'throwaway', account: undefined })).toThrow(/account/);
  });

  it('the demo preset needs where alarms go and the runtime version the throwaway run proved', () => {
    expect(() => deployConfig({ preset: 'demo', account: REAL, runtimeVersionArn: TEST_RUNTIME_VERSION })).toThrow(/alert/);
    expect(() => deployConfig({ preset: 'demo', account: REAL, alertEmail: 'ops@example.com' })).toThrow(/runtime/);
    expect(deployConfig({ preset: 'demo', account: REAL, alertEmail: 'ops@example.com', runtimeVersionArn: TEST_RUNTIME_VERSION }).env.account).toBe(REAL);
  });

  it("a preset that isn't one is refused", () => {
    expect(() => deployConfig({ preset: 'prod' as never, account: REAL })).toThrow(/throwaway or demo/);
  });

  it("the stack says the catalog's address, which the client is pointed at", () => {
    const { stack } = buildApp({ preset: 'throwaway', account: REAL }, FIXTURE_CODE);
    const outputs = Template.fromStack(stack).toJSON().Outputs as Record<string, { Value: unknown }>;
    expect(JSON.stringify(outputs['CatalogUrl']!.Value)).toContain('DomainName');
  });
});

describe('the deploy plan', () => {
  const plan = deployPlan({ preset: 'throwaway', account: REAL, logins: 'ana,bob', clientId: 'Iv1.abc' });

  it('prints every step in order, with the pinned CDK CLI, and the client side last', () => {
    const order = ['github.com/settings/applications/new', 'ssm put-parameter', 'origin-secret', `${CDK_CLI} bootstrap aws://${REAL}/us-east-1`, `${CDK_CLI} deploy`, 'SKILLS_CATALOG=', 'skills-catalog login'];
    let at = -1;
    for (const want of order) {
      const i = plan.indexOf(want, at + 1);
      expect(i, want).toBeGreaterThan(at);
      at = i;
    }
    expect(plan).toContain('--parameters GitHubClientId=Iv1.abc');
    expect(plan).toContain('--parameters SignInLogins=ana,bob');
    expect(plan).toContain('$5');
  });

  it('never puts a secret on the command line: the GitHub secret is typed at a prompt, the origin secret made in the shell', () => {
    expect(plan).not.toMatch(/--value\s+['"]?[A-Za-z0-9]{20,}/);
    expect(plan).toContain('read -rs');
    expect(plan).toContain('openssl rand');
  });

  it('refuses the placeholder account too', () => {
    expect(() => deployPlan({ preset: 'throwaway', account: ACCOUNT, logins: '', clientId: '' })).toThrow(/placeholder/);
  });

  it('the plan and the app run nothing: no child process, no AWS client', () => {
    for (const f of ['../src/deploy-plan.ts', '../src/app.ts', '../scripts/deploy-plan.ts', '../bin/app.ts']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/child_process|@aws-sdk|execSync|spawn\(/);
    }
  });
});
