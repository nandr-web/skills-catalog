// The hosted catalog's tokens (contract §1.1 "Who's asking, hosted"): a GitHub sign-in session or a personal token, each
// with a scope (read or publish) and an expiry, stored only as its hash; unknown, revoked or expired, it's nobody.

import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStores, HostedTokenStore, type Place } from '../src/index.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

let n = 0;
async function world() {
  const place: Place = { table: `tokens-${++n}`, bucket: `tokens-${n}` };
  const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
  await createStores(ddb, new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true }), place);
  let t = Date.parse('2026-09-29T12:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
  return { ddb, place, clock, tokens: new HostedTokenStore({ ddb, place, clock }) };
}

describe('tokens', () => {
  it('a token issued is verified as its owner, scope and kind; the table holds only its hash', async () => {
    const w = await world();
    const token = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: new Date(Date.parse('2026-10-29T12:00:00Z')) });
    expect(await w.tokens.verify(token)).toEqual({ owner: 'ana', scope: 'publish', kind: 'personal' });
    const items = JSON.stringify((await w.ddb.send(new ScanCommand({ TableName: w.place.table }))).Items);
    expect(items).not.toContain(token);
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('an unknown token, a revoked one, and one at its expiry are nobody', async () => {
    const w = await world();
    const expiresAt = new Date(w.clock.now().getTime() + 3_600_000);
    const token = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt });
    expect(await w.tokens.verify(`${token}x`)).toBeUndefined();
    expect(await w.tokens.verify('')).toBeUndefined();
    w.clock.advance(3_600_000 - 1000);
    expect(await w.tokens.verify(token)).toMatchObject({ owner: 'ana' });
    w.clock.advance(1000);
    expect(await w.tokens.verify(token)).toBeUndefined();
    const other = await w.tokens.issue({ owner: 'bo', scope: 'publish', kind: 'personal', expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    await w.tokens.revoke(other);
    expect(await w.tokens.verify(other)).toBeUndefined();
  });

  it('revoking keeps the record, marked revoked, and never deletes anything; the token is nobody from then on', async () => {
    const w = await world();
    const token = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    const sent: string[] = [];
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = ((cmd: { constructor: { name: string } }, ...rest: unknown[]) => (sent.push(cmd.constructor.name), (send as any)(cmd, ...rest))) as typeof w.ddb.send;
    w.clock.advance(1000);
    await w.tokens.revoke(token);
    expect(sent.filter((c) => /Delete/.test(c))).toEqual([]);
    expect(await w.tokens.verify(token)).toBeUndefined();
    const items = (await w.ddb.send(new ScanCommand({ TableName: w.place.table }))).Items ?? [];
    const record = items.find((i) => i['sk']?.S === 'token');
    expect(record?.['revoked_at']?.S).toBe(w.clock.now().toISOString());
  });

  it('only a read or publish scope, and an expiry in the future, can be issued', async () => {
    const w = await world();
    const later = new Date(w.clock.now().getTime() + 1000);
    await expect(w.tokens.issue({ owner: 'ana', scope: 'admin' as never, kind: 'personal', expiresAt: later })).rejects.toThrow();
    await expect(w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'personal', expiresAt: w.clock.now() })).rejects.toThrow();
  });
});
