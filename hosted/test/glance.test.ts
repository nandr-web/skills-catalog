// The files route's look at a stored file (contract §1.1): never its bytes. A head with S3's checksum asked for, and its
// tags: stored or absent, when it was uploaded, and whether it's the file its name says. S3 gives the SHA-256 it
// checked at the upload (the upload link signs it); a different one is another file, and none given (a stand-in that
// doesn't keep checksums) trusts the link's signed checksum. The commit's full hash check is inspect's, not this.

import { GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { glance } from '../src/blobs.ts';

const SHA = 'ab'.repeat(32);
const base64Of = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const UPLOADED = new Date('2026-09-29T10:00:00Z');

function s3(head: () => Record<string, unknown>) {
  const sent: unknown[] = [];
  const client = {
    send: async (cmd: unknown) => {
      sent.push(cmd);
      if (cmd instanceof HeadObjectCommand) return head();
      if (cmd instanceof GetObjectTaggingCommand) return { TagSet: [{ Key: 'claimed', Value: '2026-09-29T11:00:00Z' }] };
      throw new Error(`not expected: ${(cmd as object).constructor.name}`);
    },
  } as unknown as S3Client;
  return { client, sent };
}

describe("the files route's look at a file", () => {
  it("asks for the head with S3's checksum, and the tags; never the bytes", async () => {
    const t = s3(() => ({ LastModified: UPLOADED, ChecksumSHA256: base64Of(SHA) }));
    expect(await glance(t.client, { table: 't', bucket: 'b' }, SHA)).toEqual({ kind: 'stored', matches: true, uploaded: UPLOADED, tags: { claimed: '2026-09-29T11:00:00Z' } });
    expect(t.sent.some((c) => c instanceof GetObjectCommand)).toBe(false);
    const head = t.sent.find((c) => c instanceof HeadObjectCommand) as HeadObjectCommand;
    expect(head.input).toMatchObject({ Bucket: 'b', ChecksumMode: 'ENABLED' });
  });

  it("a checksum S3 gives that isn't the name's: not the file its name says", async () => {
    const t = s3(() => ({ LastModified: UPLOADED, ChecksumSHA256: base64Of('cd'.repeat(32)) }));
    expect(await glance(t.client, { table: 't', bucket: 'b' }, SHA)).toMatchObject({ kind: 'stored', matches: false });
  });

  it("no checksum given: the upload link's signed checksum is trusted", async () => {
    const t = s3(() => ({ LastModified: UPLOADED }));
    expect(await glance(t.client, { table: 't', bucket: 'b' }, SHA)).toMatchObject({ kind: 'stored', matches: true });
  });

  it('a file that is not there is absent; any other failure is thrown', async () => {
    const missing = s3(() => {
      throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    });
    expect(await glance(missing.client, { table: 't', bucket: 'b' }, SHA)).toEqual({ kind: 'absent' });
    const broken = s3(() => {
      throw Object.assign(new Error('SlowDown'), { $metadata: { httpStatusCode: 503 } });
    });
    await expect(glance(broken.client, { table: 't', bucket: 'b' }, SHA)).rejects.toThrow(/SlowDown/);
  });
});
