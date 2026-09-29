// A stored file as the commit, the upload links and the sweep see it (contract §1.1), one way for all three (the files
// route's look, glance, reads only its head). Its bytes
// must hash to its name: a file uploaded without the checksum S3 verifies, or with other bytes, can never be committed.
// Its age is the later of its upload and its last claim (the `claimed` tag); the sweep marks a file `deleting` before
// it deletes it. Tags are read and written as a whole set (a put replaces them all), so nothing assumes a tag survived.

import { createHash } from 'node:crypto';
import { GetObjectCommand, GetObjectTaggingCommand, HeadObjectCommand, PutObjectTaggingCommand, type HeadObjectCommandOutput, type S3Client } from '@aws-sdk/client-s3';
import { blobKey, type Place } from './place.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A commit takes a file only while its age is under this. */
export const COMMIT_AGE_MS = DAY;
/** The sweep marks an unreferenced file older than this, and deletes it at least MARK_WAIT_MS later if it still is. */
export const SWEEP_AGE_MS = 7 * DAY;
export const MARK_WAIT_MS = HOUR;

export type Tags = Record<string, string>;
export type Blob =
  | { kind: 'absent' }
  | { kind: 'stored'; matches: boolean; uploaded: Date; tags: Tags };

const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
const notThere = (e: unknown) => status(e) === 404 || (e as { name?: string }).name === 'NoSuchKey';

export async function readTags(s3: S3Client, place: Place, sha256: string): Promise<Tags> {
  const r = await s3.send(new GetObjectTaggingCommand({ Bucket: place.bucket, Key: blobKey(sha256) }));
  return Object.fromEntries((r.TagSet ?? []).map((t) => [t.Key!, t.Value!]));
}

/** The whole tag set, read, changed and written back. */
export async function changeTags(s3: S3Client, place: Place, sha256: string, change: (tags: Tags) => Tags): Promise<void> {
  const tags = change(await readTags(s3, place, sha256));
  await s3.send(new PutObjectTaggingCommand({ Bucket: place.bucket, Key: blobKey(sha256), Tagging: { TagSet: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) } }));
}

/** The file named `sha256`: absent, or stored with whether its bytes hash to its name, its upload time and its tags. */
export async function inspect(s3: S3Client, place: Place, sha256: string): Promise<Blob> {
  let bytes: Uint8Array;
  let uploaded: Date;
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: place.bucket, Key: blobKey(sha256) }));
    bytes = await r.Body!.transformToByteArray();
    uploaded = r.LastModified ?? new Date(0);
  } catch (e) {
    if (notThere(e)) return { kind: 'absent' };
    throw e;
  }
  const matches = createHash('sha256').update(bytes).digest('hex') === sha256;
  return { kind: 'stored', matches, uploaded, tags: await readTags(s3, place, sha256) };
}

/** The file named `sha256` as the files route sees it, never reading its bytes: a head with S3's checksum asked for, and
 *  its tags. S3 gives the SHA-256 it checked at the upload (the upload link signs it); a different one is another file.
 *  None given (a stand-in that keeps no checksums) trusts the link's signed checksum; the commit's check is inspect's. */
export async function glance(s3: S3Client, place: Place, sha256: string): Promise<Blob> {
  let r: HeadObjectCommandOutput;
  try {
    r = await s3.send(new HeadObjectCommand({ Bucket: place.bucket, Key: blobKey(sha256), ChecksumMode: 'ENABLED' }));
  } catch (e) {
    if (notThere(e)) return { kind: 'absent' };
    throw e;
  }
  const matches = r.ChecksumSHA256 === undefined || r.ChecksumSHA256 === Buffer.from(sha256, 'hex').toString('base64');
  return { kind: 'stored', matches, uploaded: r.LastModified ?? new Date(0), tags: await readTags(s3, place, sha256) };
}

/** How old a stored file is: from the later of its upload and its last claim. */
export function ageOf(b: Extract<Blob, { kind: 'stored' }>, now: Date): number {
  const claimed = b.tags['claimed'] ? Date.parse(b.tags['claimed']) : NaN;
  const since = Number.isFinite(claimed) ? Math.max(claimed, b.uploaded.getTime()) : b.uploaded.getTime();
  return now.getTime() - since;
}

/** Whether a commit may reference it now: bytes that hash to its name, under a day old, not being removed. */
export const committable = (b: Blob, now: Date): boolean => b.kind === 'stored' && b.matches && b.tags['deleting'] === undefined && ageOf(b, now) < COMMIT_AGE_MS;
