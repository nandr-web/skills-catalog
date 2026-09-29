// The upload links' look at each file (contract §1.1): stored or not is a head and the tags (glance), never the bytes,
// a few files at a time, answered in the request's order. The commit checks the bytes of the files it names.

import { GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand, PutObjectTaggingCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { HostedBlobLinks } from '../src/links.ts';

const place = { table: 't', bucket: 'b' };
const clock = { now: () => new Date('2026-09-29T12:00:00Z') };
const base64Of = (hex: string) => Buffer.from(hex, 'hex').toString('base64');
const shaOf = (i: number) => i.toString(16).padStart(64, '0');

/** A client whose presigner works offline, and whose sends are answered here: files with an even number are stored. */
function fakeS3(opts: { checksum?: (sha: string) => string | undefined } = {}) {
  const s3 = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' }, endpoint: 'http://127.0.0.1:9', forcePathStyle: true });
  const sent: string[] = [];
  let inFlight = 0;
  let most = 0;
  s3.send = (async (cmd: { input: { Key?: string } }) => {
    sent.push(cmd.constructor.name);
    const sha = cmd.input.Key!.split('/').pop()!;
    inFlight++;
    most = Math.max(most, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    if (cmd instanceof HeadObjectCommand) {
      if (parseInt(sha, 16) % 2 === 1) throw Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      const c = opts.checksum ? opts.checksum(sha) : base64Of(sha);
      return { LastModified: new Date('2026-09-29T11:00:00Z'), ...(c !== undefined ? { ChecksumSHA256: c } : {}) };
    }
    if (cmd instanceof GetObjectTaggingCommand) return { TagSet: [] };
    if (cmd instanceof PutObjectTaggingCommand) return {};
    throw new Error(`not expected: ${cmd.constructor.name}`);
  }) as unknown as S3Client['send'];
  return { s3, sent, most: () => most };
}

describe('upload links', () => {
  it('a 100-file request reads no file\'s bytes, looks at 8 at most at once, and answers in the request\'s order', async () => {
    const f = fakeS3();
    const links = new HostedBlobLinks({ s3: f.s3, place, clock });
    const files = Array.from({ length: 100 }, (_, i) => ({ sha256: shaOf(i), size: 10 }));
    const answers = await links.uploadLinks(files);
    expect(f.sent.filter((c) => c === GetObjectCommand.name)).toEqual([]);
    expect(f.most()).toBeLessThanOrEqual(8);
    expect(f.most()).toBeGreaterThan(1);
    expect(answers.map((a) => a.sha256)).toEqual(files.map((x) => x.sha256));
    expect(answers.map((a) => a.kind)).toEqual(files.map((_, i) => (i % 2 === 1 ? 'upload' : 'stored')));
  });

  it('a stored file whose checksum isn\'t its name is being removed, and isn\'t claimed', async () => {
    const f = fakeS3({ checksum: () => base64Of('cd'.repeat(32)) });
    const links = new HostedBlobLinks({ s3: f.s3, place, clock });
    const [a] = await links.uploadLinks([{ sha256: shaOf(2), size: 10 }]);
    expect(a!.kind).toBe('removing');
    expect(f.sent).not.toContain(PutObjectTaggingCommand.name);
  });

  it('no checksum given (a stand-in that keeps none): the signed upload is trusted, so it\'s stored and claimed', async () => {
    const f = fakeS3({ checksum: () => undefined });
    const links = new HostedBlobLinks({ s3: f.s3, place, clock });
    const [a] = await links.uploadLinks([{ sha256: shaOf(2), size: 10 }]);
    expect(a!.kind).toBe('stored');
    expect(f.sent).toContain(PutObjectTaggingCommand.name);
  });
});
