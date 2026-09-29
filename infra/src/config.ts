// The stack's settings, one typed file (the web build notes): two presets, throwaway (a QA run's stack, deleted whole)
// and demo (kept). The account and region are fixed here, never looked up; the account is set at the deploy go.

import { RemovalPolicy } from 'aws-cdk-lib';

export type PresetName = 'throwaway' | 'demo';

export type StageConfig = {
  preset: PresetName;
  env: { account: string; region: string };
  /** What happens to the stores when the stack goes: throwaway deletes everything; demo keeps its data. */
  removal: RemovalPolicy;
  /** Point-in-time recovery for the table, versions for the bucket (demo). */
  keepHistory: boolean;
  /** Requests a second the API takes, and its burst, before it answers 429. */
  throttle: { rate: number; burst: number };
  /** The parameter store name of the GitHub sign-in app's secret (the owner creates it; the stack only names it). */
  githubSecretParameter: string;
};

/** Set at the deploy go (the owner's account); synth needs only a fixed value. */
export const ACCOUNT = '111111111111';
export const REGION = 'us-east-1';

export const PRESETS: Record<PresetName, StageConfig> = {
  throwaway: { preset: 'throwaway', env: { account: ACCOUNT, region: REGION }, removal: RemovalPolicy.DESTROY, keepHistory: false, throttle: { rate: 20, burst: 40 }, githubSecretParameter: '/skills-catalog/throwaway/github-oauth-secret' },
  demo: { preset: 'demo', env: { account: ACCOUNT, region: REGION }, removal: RemovalPolicy.RETAIN, keepHistory: true, throttle: { rate: 50, burst: 100 }, githubSecretParameter: '/skills-catalog/demo/github-oauth-secret' },
};
