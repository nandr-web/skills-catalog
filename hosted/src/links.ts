// BlobLinks, hosted only (contract §1.1): short-lived links to put a file by its sha256, or to read one. A file not
// stored gets a presigned PUT that signs put-if-absent, its SHA-256 and its size; a stored one is claimed (its `claimed`
// tag set to now, so a commit in the next day takes it) and answered as already stored; one being removed (marked
// `deleting`, or bytes that don't hash to its name) gets no link and no claim, only when to try again.

import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobLinks, Clock, UploadAnswer } from '@skills-catalog/core';
import { changeTags, inspect, MARK_WAIT_MS } from './blobs.ts';
import { blobKey, type Place } from './place.ts';

/** How long a link works. */
export const LINK_SECONDS = 300;

const base64Of = (hex: string) => Buffer.from(hex, 'hex').toString('base64');

export class HostedBlobLinks implements BlobLinks {
  private readonly p: { s3: S3Client; place: Place; clock: Clock };

  constructor(parts: { s3: S3Client; place: Place; clock: Clock }) {
    this.p = parts;
  }

  async uploadLinks(files: readonly { sha256: string; size: number }[]): Promise<UploadAnswer[]> {
    const out: UploadAnswer[] = [];
    for (const f of files) {
      const b = await inspect(this.p.s3, this.p.place, f.sha256);
      const now = this.p.clock.now();
      if (b.kind === 'absent') {
        const checksum = base64Of(f.sha256);
        const url = await getSignedUrl(
          this.p.s3,
          new PutObjectCommand({ Bucket: this.p.place.bucket, Key: blobKey(f.sha256), IfNoneMatch: '*', ChecksumSHA256: checksum, ContentLength: f.size }),
          { expiresIn: LINK_SECONDS, unhoistableHeaders: new Set(['if-none-match', 'x-amz-checksum-sha256']) },
        );
        out.push({ kind: 'upload', sha256: f.sha256, url, headers: { 'if-none-match': '*', 'x-amz-checksum-sha256': checksum } });
        continue;
      }
      const marked = b.tags['deleting'];
      if (marked !== undefined || !b.matches) {
        // The sweep removes it at its next pass after the mark (a mismatched file is marked and removed at once).
        const from = marked !== undefined && Number.isFinite(Date.parse(marked)) ? Date.parse(marked) : now.getTime();
        out.push({ kind: 'removing', sha256: f.sha256, retry_after: new Date(from + MARK_WAIT_MS).toISOString() });
        continue;
      }
      await changeTags(this.p.s3, this.p.place, f.sha256, (tags) => ({ ...tags, claimed: now.toISOString() }));
      out.push({ kind: 'stored', sha256: f.sha256 });
    }
    return out;
  }

  async downloadLink(sha256: string): Promise<string> {
    return getSignedUrl(this.p.s3, new GetObjectCommand({ Bucket: this.p.place.bucket, Key: blobKey(sha256) }), { expiresIn: LINK_SECONDS });
  }
}
