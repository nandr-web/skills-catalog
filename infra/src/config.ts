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
  /** The origin secret CloudFront sends the API, current and previous (the deploy script creates and rotates them). */
  originSecretParameters: { current: string; previous: string };
  /** Requests from one address in 5 minutes before the edge blocks it. */
  rateLimitPer5Min: number;
  /** Demo: the exact Lambda runtime version the throwaway smoke test proved (manual runtime updates). */
  runtimeVersionArn?: string | undefined;
  /** Demo: a monthly budget in US dollars, and CloudFront's flat-rate Free plan. */
  budgetUsd?: number | undefined;
  freePlan: boolean;
};

/** Set at the deploy go (the owner's account); synth needs only a fixed value. */
export const ACCOUNT = '111111111111';
export const REGION = 'us-east-1';

/** What each preset names the same way: its account and region, and its parameters under /skills-catalog/<preset>/. */
function named(preset: PresetName) {
  const p = `/skills-catalog/${preset}`;
  return {
    preset,
    env: { account: ACCOUNT, region: REGION },
    githubSecretParameter: `${p}/github-oauth-secret`,
    originSecretParameters: { current: `${p}/origin-secret`, previous: `${p}/origin-secret-previous` },
  };
}

export const PRESETS: Record<PresetName, StageConfig> = {
  throwaway: { ...named('throwaway'), removal: RemovalPolicy.DESTROY, keepHistory: false, throttle: { rate: 20, burst: 40 }, rateLimitPer5Min: 1000, freePlan: false },
  // runtimeVersionArn is set at the demo deploy go, to the version the throwaway smoke test proved.
  demo: { ...named('demo'), removal: RemovalPolicy.RETAIN, keepHistory: true, throttle: { rate: 50, burst: 100 }, rateLimitPer5Min: 2000, budgetUsd: 10, freePlan: true },
};
