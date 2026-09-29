// The hosted catalog's stack (the AWS build brief, slice 3; the web build notes): one CatalogStack built from constructs
// with explicit props, the same for both presets; no `if (preset)` inside a construct.

import { Stack } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import type { StageConfig } from './config.ts';
import { Storage } from './constructs/storage.ts';

export class CatalogStack extends Stack {
  readonly storage: Storage;

  constructor(scope: Construct, id: string, config: StageConfig) {
    super(scope, id, { env: config.env });
    this.storage = new Storage(this, 'Storage', { removal: config.removal, keepHistory: config.keepHistory });
  }
}
