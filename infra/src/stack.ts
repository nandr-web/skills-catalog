// The hosted catalog's stack (the AWS build brief, slice 3; the web build notes): one CatalogStack built from constructs
// with explicit props, the same for both presets; no `if (preset)` inside a construct.

import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';
import type { CodeEntries } from './constructs/function.ts';
import { Api, Indexer, Sweep } from './constructs/functions.ts';
import { Storage } from './constructs/storage.ts';

export class CatalogStack extends Stack {
  readonly storage: Storage;
  readonly api: Api;
  readonly indexer: Indexer;
  readonly sweep: Sweep;

  constructor(scope: Construct, id: string, config: StageConfig, code: CodeEntries) {
    super(scope, id, { env: config.env });
    this.storage = new Storage(this, 'Storage', { removal: config.removal, keepHistory: config.keepHistory });
    const fn = (entry: string) => ({ entry, projectRoot: code.projectRoot, storage: this.storage, removal: config.removal });
    this.api = new Api(this, 'Api', fn(code.api));
    this.indexer = new Indexer(this, 'Indexer', fn(code.indexer));
    this.sweep = new Sweep(this, 'Sweep', fn(code.sweep));
  }
}
