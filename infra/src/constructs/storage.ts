// The catalog's stores (contract §7): one DynamoDB table for versions, owners, events and tokens (its stream feeds the
// indexer), and one S3 bucket for skill files (blobs/<sha256>, create-only) and the search file. No lifecycle rule
// expires anything: the sweep removes unreferenced files in two passes (contract §1.1).

import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, StreamViewType, Table } from 'aws-cdk-lib/aws-dynamodb';
import { AnyPrincipal, Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export type StorageProps = { removal: RemovalPolicy; keepHistory: boolean };

/** Where a skill file lives in the bucket (hosted/src/place.ts's BLOB_PREFIX). */
export const BLOB_PREFIX = 'blobs/';

export class Storage extends Construct {
  readonly table: Table;
  readonly bucket: Bucket;

  constructor(scope: Construct, id: string, props: StorageProps) {
    super(scope, id);
    this.table = new Table(this, 'Table', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      stream: StreamViewType.NEW_IMAGE,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: props.keepHistory },
      removalPolicy: props.removal,
    });
    const destroy = props.removal === RemovalPolicy.DESTROY;
    this.bucket = new Bucket(this, 'Files', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      versioned: props.keepHistory,
      removalPolicy: props.removal,
      autoDeleteObjects: destroy,
    });
    // Every skill file is written once: a put without "only if absent" is refused, whoever sends it.
    this.bucket.addToResourcePolicy(
      new PolicyStatement({
        effect: Effect.DENY,
        principals: [new AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects(`${BLOB_PREFIX}*`)],
        conditions: { Null: { 's3:if-none-match': 'true' } },
      }),
    );
  }
}
