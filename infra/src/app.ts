// The CDK app for a real deploy (slice 4): the preset's settings with the owner's account and, for demo, where alarms go
// and the runtime version the throwaway run proved. The placeholder account the tests synthesize with is refused, so a
// deploy can never go to it. Nothing here runs a deploy: bin/app.ts is what `cdk` starts, at the owner's deploy go.

import { App } from 'aws-cdk-lib';
import { ACCOUNT, PRESETS, type PresetName, type StageConfig } from './config.ts';
import type { CodeEntries } from './constructs/function.ts';
import { CatalogStack } from './stack.ts';

export type DeployInput = { preset: PresetName; account: string | undefined; alertEmail?: string | undefined; runtimeVersionArn?: string | undefined; originSecretVersion?: number | undefined };

export function deployConfig(i: DeployInput): StageConfig {
  if (i.preset !== 'throwaway' && i.preset !== 'demo') throw new Error(`the preset is throwaway or demo, not ${String(i.preset)}`);
  if (!i.account) throw new Error('the AWS account to deploy to is needed (CDK_DEFAULT_ACCOUNT, or -c account=<12 digits>)');
  if (i.account === ACCOUNT) throw new Error(`${ACCOUNT} is the placeholder account the tests synthesize with; name the real one`);
  if (!/^\d{12}$/.test(i.account)) throw new Error(`an AWS account is 12 digits, not ${i.account}`);
  if (i.preset === 'demo' && !i.alertEmail) throw new Error('the demo stack needs an email address for its alerts (-c alertEmail=…)');
  if (i.preset === 'demo' && !i.runtimeVersionArn) throw new Error('the demo stack needs the exact runtime version the throwaway smoke test proved (-c runtimeVersionArn=…)');
  const base = PRESETS[i.preset];
  return {
    ...base,
    env: { ...base.env, account: i.account },
    ...(i.alertEmail ? { alertEmail: i.alertEmail } : {}),
    ...(i.runtimeVersionArn ? { runtimeVersionArn: i.runtimeVersionArn } : {}),
    ...(i.originSecretVersion ? { originSecretVersion: i.originSecretVersion } : {}),
  };
}

export const stackName = (preset: PresetName) => `skills-catalog-${preset}`;

export function buildApp(i: DeployInput, code: CodeEntries, app = new App()): { app: App; stack: CatalogStack } {
  const config = deployConfig(i);
  const stack = new CatalogStack(app, stackName(config.preset), config, code);
  return { app, stack };
}
