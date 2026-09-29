// The hosted catalog's stack (the AWS build brief, slice 3; the web build notes): one CatalogStack built from constructs
// with explicit props, the same for both presets; no `if (preset)` inside a construct. The GitHub app's client id and
// the sign-in list are the deploy's parameters, never in code. cdk-nag's findings the stack answers rather than fixes
// are answered where they arise (nag.ts).

import { CfnParameter, Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';
import type { CodeEntries } from './constructs/function.ts';
import { Events } from './constructs/events.ts';
import { Api, Indexer, Sweep } from './constructs/functions.ts';
import { Guardrails } from './constructs/guardrails.ts';
import { Site } from './constructs/site.ts';
import { Storage } from './constructs/storage.ts';
import { answerNag } from './nag.ts';

export class CatalogStack extends Stack {
  readonly storage: Storage;
  readonly api: Api;
  readonly indexer: Indexer;
  readonly sweep: Sweep;
  readonly events: Events;
  readonly site: Site;
  readonly guardrails: Guardrails;

  constructor(scope: Construct, id: string, config: StageConfig, code: CodeEntries) {
    super(scope, id, { env: config.env });
    if (config.preset === 'demo' && !config.runtimeVersionArn) throw new Error('the demo stack needs the exact runtime version the throwaway smoke test proved (runtimeVersionArn)');
    const clientId = new CfnParameter(this, 'GitHubClientId', { type: 'String', minLength: 1, description: "The GitHub OAuth app's client id" });
    const logins = new CfnParameter(this, 'SignInLogins', { type: 'String', default: '', description: 'The GitHub logins that may sign in, comma separated (login or login:id); empty is nobody' });
    this.storage = new Storage(this, 'Storage', { removal: config.removal, keepHistory: config.keepHistory });
    const fn = (entry: string) => ({ entry, projectRoot: code.projectRoot, lockFile: code.lockFile, storage: this.storage, removal: config.removal, runtimeVersionArn: config.runtimeVersionArn });
    this.api = new Api(this, 'Api', {
      ...fn(code.api),
      throttle: config.throttle,
      githubSecretParameter: config.githubSecretParameter,
      originSecretParameters: config.originSecretParameters,
      signIn: { clientId: clientId.valueAsString, logins: logins.valueAsString },
      words: code.words,
    });
    this.indexer = new Indexer(this, 'Indexer', fn(code.indexer));
    this.sweep = new Sweep(this, 'Sweep', fn(code.sweep));
    this.events = new Events(this, 'Events', { storage: this.storage, indexer: this.indexer.fn, removal: config.removal });
    this.site = new Site(this, 'Site', {
      api: this.api.http,
      originSecret: { parameter: config.originSecretParameters.current, version: config.originSecretVersion },
      removal: config.removal,
      rateLimitPer5Min: config.rateLimitPer5Min,
    });
    this.guardrails = new Guardrails(this, 'Guardrails', {
      deadLetters: this.events.deadLetters,
      pipeName: this.events.pipe.ref,
      budgetUsd: config.budgetUsd,
      alertEmail: config.alertEmail,
      freePlan: config.freePlan ? { distributionArn: this.site.distribution.distributionArn, webAclArn: this.site.webAcl.attrArn } : undefined,
    });
    answerNag(this, config.preset);
  }
}
