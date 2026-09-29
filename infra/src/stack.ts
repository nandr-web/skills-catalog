// The hosted catalog's stack (the AWS build brief, slice 3; the web build notes): one CatalogStack built from constructs
// with explicit props, the same for both presets; no `if (preset)` inside a construct.

import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';
import type { CodeEntries } from './constructs/function.ts';
import { Events } from './constructs/events.ts';
import { Api, Indexer, Sweep } from './constructs/functions.ts';
import { Guardrails } from './constructs/guardrails.ts';
import { Site } from './constructs/site.ts';
import { Storage } from './constructs/storage.ts';

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
    this.storage = new Storage(this, 'Storage', { removal: config.removal, keepHistory: config.keepHistory });
    const fn = (entry: string) => ({ entry, projectRoot: code.projectRoot, storage: this.storage, removal: config.removal, runtimeVersionArn: config.runtimeVersionArn });
    this.api = new Api(this, 'Api', { ...fn(code.api), throttle: config.throttle, githubSecretParameter: config.githubSecretParameter, originSecretParameters: config.originSecretParameters });
    this.indexer = new Indexer(this, 'Indexer', fn(code.indexer));
    this.sweep = new Sweep(this, 'Sweep', fn(code.sweep));
    this.events = new Events(this, 'Events', { storage: this.storage, indexer: this.indexer.fn, removal: config.removal });
    this.site = new Site(this, 'Site', { api: this.api.http, originSecretParameter: config.originSecretParameters.current, removal: config.removal, rateLimitPer5Min: config.rateLimitPer5Min });
    this.guardrails = new Guardrails(this, 'Guardrails', {
      deadLetters: this.events.deadLetters,
      pipeName: this.events.pipe.ref,
      budgetUsd: config.budgetUsd,
      alertEmail: config.alertEmail,
      freePlan: config.freePlan ? { distributionArn: this.site.distribution.distributionArn, webAclArn: this.site.webAcl.attrArn } : undefined,
    });
  }
}
