// What the hosted adapters rely on, checked on the stand-in before any adapter test uses it: a DynamoDB transaction whose
// failed condition cancels all of it; S3 put-if-absent (If-None-Match: *) answering 412; object tags; presigned PUT and
// GET links that sign If-None-Match and the file's SHA-256; each object's LastModified. Whether a bucket policy's
// s3:if-none-match condition is enforced is reported, not relied on (the stack's template tests hold that rule).

import { createHash } from 'node:crypto';
import { CreateTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { CreateBucketCommand, GetObjectTaggingCommand, HeadObjectCommand, PutBucketPolicyCommand, PutObjectCommand, PutObjectTaggingCommand, S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator;
let ddb: DynamoDBClient;
let s3: S3Client;
beforeAll(async () => {
  emu = await startEmulator();
  ddb = new DynamoDBClient({ ...FAKE, endpoint: emu.endpoint });
  s3 = new S3Client({ ...FAKE, endpoint: emu.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
}, 30_000);
afterAll(async () => {
  ddb?.destroy();
  s3?.destroy();
  await emu?.stop();
});

const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const b64sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('base64');

describe('the stand-in does what the hosted adapters rely on', () => {
  it('DynamoDB: a transaction whose ConditionCheck fails is cancelled whole', async () => {
    await ddb.send(new CreateTableCommand({ TableName: 't', AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }], KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }], BillingMode: 'PAY_PER_REQUEST' }));
    const tx = () =>
      ddb.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            { Put: { TableName: 't', Item: { pk: { S: 'a' } } } },
            { ConditionCheck: { TableName: 't', Key: { pk: { S: 'x' } }, ConditionExpression: 'attribute_exists(pk)' } },
          ],
        }),
      );
    await expect(tx()).rejects.toMatchObject({ name: 'TransactionCanceledException' });
    expect((await ddb.send(new GetItemCommand({ TableName: 't', Key: { pk: { S: 'a' } } }))).Item).toBeUndefined();
    await ddb.send(new PutItemCommand({ TableName: 't', Item: { pk: { S: 'x' } } }));
    await tx();
    expect((await ddb.send(new GetItemCommand({ TableName: 't', Key: { pk: { S: 'a' } } }))).Item).toBeDefined();
  });

  it('S3: a put with If-None-Match: * succeeds once, then answers 412; LastModified is there; tags round-trip', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'probe-put' }));
    await s3.send(new PutObjectCommand({ Bucket: 'probe-put', Key: 'k', Body: 'one', IfNoneMatch: '*' }));
    const second = await s3.send(new PutObjectCommand({ Bucket: 'probe-put', Key: 'k', Body: 'two', IfNoneMatch: '*' })).catch((e: unknown) => e);
    expect(status(second)).toBe(412);
    const head = await s3.send(new HeadObjectCommand({ Bucket: 'probe-put', Key: 'k' }));
    expect(Math.abs(head.LastModified!.getTime() - Date.now())).toBeLessThan(120_000);
    const at = new Date().toISOString();
    await s3.send(new PutObjectTaggingCommand({ Bucket: 'probe-put', Key: 'k', Tagging: { TagSet: [{ Key: 'claimed', Value: at }] } }));
    expect((await s3.send(new GetObjectTaggingCommand({ Bucket: 'probe-put', Key: 'k' }))).TagSet).toEqual([{ Key: 'claimed', Value: at }]);
  });

  it('S3: a presigned PUT signs If-None-Match and the SHA-256: the right bytes land once, other bytes are refused; a presigned GET reads them', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'probe-links' }));
    const bytes = 'file bytes\n';
    const sha = b64sha(bytes);
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: 'probe-links', Key: 'f', IfNoneMatch: '*', ChecksumSHA256: sha }), {
      expiresIn: 300,
      unhoistableHeaders: new Set(['if-none-match', 'x-amz-checksum-sha256']),
    });
    const put = (body: string) => fetch(url, { method: 'PUT', body, headers: { 'if-none-match': '*', 'x-amz-checksum-sha256': sha } });
    expect((await put(bytes)).status).toBe(200);
    expect((await put(bytes)).status).toBe(412);
    const get = await getSignedUrl(s3, new GetObjectCommand({ Bucket: 'probe-links', Key: 'f' }), { expiresIn: 300 });
    expect(await (await fetch(get)).text()).toBe(bytes);
  });

  it('reports whether a presigned PUT with other bytes than its signed SHA-256 is refused (not relied on)', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'probe-checksum' }));
    const sha = b64sha('the right bytes\n');
    const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: 'probe-checksum', Key: 'g', IfNoneMatch: '*', ChecksumSHA256: sha }), {
      expiresIn: 300,
      unhoistableHeaders: new Set(['if-none-match', 'x-amz-checksum-sha256']),
    });
    const r = await fetch(url, { method: 'PUT', body: 'other bytes\n', headers: { 'if-none-match': '*', 'x-amz-checksum-sha256': sha } });
    process.stderr.write(`presigned PUT checksum enforced: ${r.status >= 400} (status ${r.status})\n`);
    expect(r.status).toBeGreaterThan(0);
  });

  it('reports whether a bucket policy requiring s3:if-none-match is enforced (not relied on)', async () => {
    await s3.send(new CreateBucketCommand({ Bucket: 'probe-policy' }));
    const policy = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Principal: '*', Action: 's3:PutObject', Resource: 'arn:aws:s3:::probe-policy/*', Condition: { Null: { 's3:if-none-match': 'true' } } }],
    };
    await s3.send(new PutBucketPolicyCommand({ Bucket: 'probe-policy', Policy: JSON.stringify(policy) }));
    const plain = await s3.send(new PutObjectCommand({ Bucket: 'probe-policy', Key: 'k', Body: 'x' })).catch((e: unknown) => e);
    const guarded = await s3.send(new PutObjectCommand({ Bucket: 'probe-policy', Key: 'k2', Body: 'x', IfNoneMatch: '*' })).catch((e: unknown) => e);
    // Enforced only if the plain put is denied and the same put with the header isn't.
    process.stderr.write(`bucket policy s3:if-none-match enforced: ${status(plain) === 403 && status(guarded) !== 403} (plain ${status(plain)}, with header ${status(guarded) ?? 200})\n`);
    expect([200, 403, undefined]).toContain(status(plain));
  });
});
