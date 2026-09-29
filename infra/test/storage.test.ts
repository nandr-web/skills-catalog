// The hosted catalog's stores in the stack (the AWS build brief, slice 3): one DynamoDB table (its stream feeds the
// indexer) and one S3 bucket whose skill files are create-only, never expired by a lifecycle rule (the sweep removes
// them), private, over TLS. Two presets: throwaway retains nothing anywhere; demo keeps point-in-time recovery and
// versions.

import { Template, Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { synth } from './synth.ts';

describe('storage', () => {
  const t = synth('throwaway');

  it('one table, on demand, keyed pk/sk, with a stream of new images', () => {
    t.resourceCountIs('AWS::DynamoDB::Table', 1);
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }, { AttributeName: 'sk', KeyType: 'RANGE' }],
      StreamSpecification: { StreamViewType: 'NEW_IMAGE' },
    });
  });

  it('the skills bucket is private, encrypted and TLS only', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: Match.anyValue(),
    });
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Effect: 'Deny', Condition: { Bool: { 'aws:SecureTransport': 'false' } } })]) },
    });
  });

  it('a skill file is create-only: a put under blobs/ without If-None-Match is denied', () => {
    t.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Deny',
            Action: 's3:PutObject',
            Condition: { Null: { 's3:if-none-match': 'true' } },
            Resource: Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith(['/blobs/*'])]) }),
          }),
        ]),
      },
    });
  });

  it('no lifecycle rule expires anything in the skills bucket (the sweep removes unreferenced files)', () => {
    for (const b of Object.values(t.findResources('AWS::S3::Bucket'))) {
      const rules = (b as { Properties?: { LifecycleConfiguration?: { Rules?: { ExpirationInDays?: number; Prefix?: string }[] } } }).Properties?.LifecycleConfiguration?.Rules ?? [];
      expect(rules.filter((r) => r.ExpirationInDays !== undefined)).toEqual([]);
    }
  });
});

describe('the presets', () => {
  it('throwaway retains nothing: no resource keeps itself on delete or replace', () => {
    const t = synth('throwaway');
    const kept = Object.entries(t.toJSON().Resources as Record<string, { DeletionPolicy?: string; UpdateReplacePolicy?: string }>)
      .filter(([, r]) => ['Retain', 'RetainExceptOnCreate', 'Snapshot'].includes(r.DeletionPolicy ?? '') || r.UpdateReplacePolicy === 'Retain')
      .map(([id]) => id);
    expect(kept).toEqual([]);
  });

  it('demo keeps the data: point-in-time recovery, versions, and the table and bucket retained', () => {
    const t = synth('demo');
    t.hasResourceProperties('AWS::DynamoDB::Table', { PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true } });
    t.hasResourceProperties('AWS::S3::Bucket', { VersioningConfiguration: { Status: 'Enabled' } });
    t.hasResource('AWS::DynamoDB::Table', { DeletionPolicy: 'Retain' });
  });

  it('the account and region are fixed in code, never looked up', () => {
    const t = synth('throwaway');
    expect(JSON.stringify(t.toJSON())).not.toMatch(/fromLookup|AWS::NoValue.*Lookup/);
  });
});
