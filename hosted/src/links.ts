// BlobLinks, hosted only (contract §1.1): short-lived links to put a file by its sha256, or to read one. A file not
// stored gets a presigned PUT that signs put-if-absent, its SHA-256 and its size; a stored one is claimed (its `claimed`
// tag set to now, so a commit in the next day takes it) and answered as already stored; one being removed (marked
// `deleting`, or a checksum S3 kept that isn't its name) gets no link and no claim, only when to try again.

import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobLinks, Clock, UploadAnswer } from '@skills-catalog/core';
import { changeTags, glance, MARK_WAIT_MS } from './blobs.ts';
import { blobKey, type Place } from './place.ts';

/** How long a link works. */
export const LINK_SECONDS = 300;
/** How many files a request for links looks at once. */
const LOOKS_AT_ONCE = 8;

const base64Of = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

export class HostedBlobLinks implements BlobLinks {
  private readonly p: { s3: S3Client; place: Place; clock: Clock };

  constructor(parts: { s3: S3Client; place: Place; clock: Clock }) {
    this.p = parts;
  }

  async uploadLinks(files: readonly { sha256: string; size: number }[]): Promise<UploadAnswer[]> {
    const out: UploadAnswer[] = [];
    // A few at a time, in the request's order: a hundred files looked at one by one would be slow to answer.
    for (let at = 0; at < files.length; at += LOOKS_AT_ONCE) out.push(...(await Promise.all(files.slice(at, at + LOOKS_AT_ONCE).map((f) => this.answer(f)))));
    return out;
  }

  // Stored or not by the file's head and tags (glance), never its bytes: the commit checks the bytes of what it names.
  private async answer(f: { sha256: string; size: number }): Promise<UploadAnswer> {
    const b = await glance(this.p.s3, this.p.place, f.sha256);
    const now = this.p.clock.now();
    if (b.kind === 'absent') {
      const checksum = base64Of(f.sha256);
      const url = await getSignedUrl(
        this.p.s3,
        new PutObjectCommand({ Bucket: this.p.place.bucket, Key: blobKey(f.sha256), IfNoneMatch: '*', ChecksumSHA256: checksum, ContentLength: f.size }),
        { expiresIn: LINK_SECONDS, unhoistableHeaders: new Set(['if-none-match', 'x-amz-checksum-sha256']) },
      );
      return { kind: 'upload', sha256: f.sha256, url, headers: { 'if-none-match': '*', 'x-amz-checksum-sha256': checksum } };
    }
    const marked = b.tags['deleting'];
    if (marked !== undefined || !b.matches) {
      // The sweep removes it at its next pass after the mark (a mismatched file is marked and removed at once).
      const from = marked !== undefined && Number.isFinite(Date.parse(marked)) ? Date.parse(marked) : now.getTime();
      return { kind: 'removing', sha256: f.sha256, retry_after: new Date(from + MARK_WAIT_MS).toISOString() };
    }
    await changeTags(this.p.s3, this.p.place, f.sha256, (tags) => ({ ...tags, claimed: now.toISOString() }));
    return { kind: 'stored', sha256: f.sha256 };
  }

  async downloadLink(sha256: string): Promise<string> {
    return getSignedUrl(this.p.s3, new GetObjectCommand({ Bucket: this.p.place.bucket, Key: blobKey(sha256) }), { expiresIn: LINK_SECONDS });
  }
}
