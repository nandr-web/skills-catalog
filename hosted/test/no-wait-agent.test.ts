// The tests' no-wait agent (no-wait-agent.ts): it ends a connection by reset only once its answer is read, so a large
// body still arrives whole; and nothing the hosted package ships can use it (real AWS traffic keeps its connections).

import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CreateBucketCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('the no-wait agent', () => {
  it('a 5 MiB object comes back whole through it', async () => {
    const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true });
    try {
      await s3.send(new CreateBucketCommand({ Bucket: 'no-wait' }));
      const body = randomBytes(5 * 1024 * 1024);
      await s3.send(new PutObjectCommand({ Bucket: 'no-wait', Key: 'big', Body: body }));
      for (let i = 0; i < 3; i++) {
        const got = await (await s3.send(new GetObjectCommand({ Bucket: 'no-wait', Key: 'big' }))).Body!.transformToByteArray();
        expect([got.length, sha(got)]).toEqual([body.length, sha(body)]);
      }
    } finally {
      s3.destroy();
    }
  }, 30_000);

  it('nothing under src imports it, nor anything else of the tests', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((f) => /no-wait-agent|from\s+['"][^'"]*\/test\//.test(readFileSync(join(src, f), 'utf8')))).toEqual([]);
  });
});
