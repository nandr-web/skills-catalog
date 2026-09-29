// Where the hosted catalog keeps things (one DynamoDB table, one S3 bucket), shared by the adapters, the tests and the
// stack's constructs so each names them one way.
//
// The table's items (pk / sk, both strings):
//   skills / <name>                      owners (list), latest (number): the skill and its latest pointer
//   v#<name> / <version, 10 digits>      data (the version's record as JSON), fingerprint
//   fp#<fingerprint> / <name>#<version>  one per version, so the first by name and version answers a fingerprint
//   events / <at>#<name>#<version>       event (JSON), delivered (true once handed to the index)
//   file#<sha256> / <name>#<version>     one per file of a version, written by the indexer after the publish
//   token#<hash> / token, tokens#<owner> / <id>   a Bearer token by its hash, and under its owner by its public id
//   login#<login> / github               github_id: GitHub's numeric id, recorded at the login's first sign-in
// The bucket's objects:
//   blobs/<sha256>                       a file's bytes, put once (If-None-Match: *); tags `claimed` and `deleting`
//   search/cards.json                    the search cards, rewritten with If-Match on its ETag

import { CreateTableCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, type S3Client } from '@aws-sdk/client-s3';

export type Place = { table: string; bucket: string };

export const BLOB_PREFIX = 'blobs/';
export const SEARCH_KEY = 'search/cards.json';
export const blobKey = (sha256: string) => `${BLOB_PREFIX}${sha256}`;
export const versionSk = (version: number) => String(version).padStart(10, '0');

/** The table and bucket, made empty: for tests on the stand-in (the stack makes them in AWS). */
export async function createStores(ddb: DynamoDBClient, s3: S3Client, place: Place): Promise<void> {
  await ddb.send(
    new CreateTableCommand({
      TableName: place.table,
      AttributeDefinitions: [
        { AttributeName: 'pk', AttributeType: 'S' },
        { AttributeName: 'sk', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'pk', KeyType: 'HASH' },
        { AttributeName: 'sk', KeyType: 'RANGE' },
      ],
      BillingMode: 'PAY_PER_REQUEST',
    }),
  );
  await s3.send(new CreateBucketCommand({ Bucket: place.bucket }));
}
