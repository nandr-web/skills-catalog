// The hosted catalog's tokens (contract §1.1 "Who's asking, hosted", "Getting a token, hosted"): a GitHub sign-in
// session or a personal token, each with a public id, a scope (read or publish) and an expiry, stored only as its hash;
// unknown, revoked or expired, it's nobody. Its owner lists theirs by id (never the token) and revokes one by id.

import { createHash } from 'node:crypto';
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
    const { token, id } = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: new Date(Date.parse('2026-10-29T12:00:00Z')) });
    expect(id).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await w.tokens.verify(token)).toEqual({ owner: 'ana', scope: 'publish', kind: 'personal' });
    const items = JSON.stringify((await w.ddb.send(new ScanCommand({ TableName: w.place.table }))).Items);
    expect(items).not.toContain(token);
    expect(token.length).toBeGreaterThanOrEqual(40);
  });

  it('an unknown token, a revoked one, and one at its expiry are nobody', async () => {
    const w = await world();
    const expiresAt = new Date(w.clock.now().getTime() + 3_600_000);
    const { token } = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt });
    expect(await w.tokens.verify(`${token}x`)).toBeUndefined();
    expect(await w.tokens.verify('')).toBeUndefined();
    w.clock.advance(3_600_000 - 1000);
    expect(await w.tokens.verify(token)).toMatchObject({ owner: 'ana' });
    w.clock.advance(1000);
    expect(await w.tokens.verify(token)).toBeUndefined();
    const other = await w.tokens.issue({ owner: 'bo', scope: 'publish', kind: 'personal', expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    expect(await w.tokens.revoke('bo', other.id)).toBe(true);
    expect(await w.tokens.verify(other.token)).toBeUndefined();
  });

  it('revoking keeps the record, marked revoked, and never deletes anything; the token is nobody from then on', async () => {
    const w = await world();
    const { token, id } = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    const sent: string[] = [];
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = ((cmd: { constructor: { name: string } }, ...rest: unknown[]) => (sent.push(cmd.constructor.name), (send as any)(cmd, ...rest))) as typeof w.ddb.send;
    w.clock.advance(1000);
    expect(await w.tokens.revoke('ana', id)).toBe(true);
    expect(await w.tokens.revoke('ana', id)).toBe(true); // again: still revoked, its time unchanged
    expect(sent.filter((c) => /Delete/.test(c))).toEqual([]);
    expect(await w.tokens.verify(token)).toBeUndefined();
    const items = (await w.ddb.send(new ScanCommand({ TableName: w.place.table }))).Items ?? [];
    const record = items.find((i) => i['sk']?.S === 'token');
    expect(record?.['revoked_at']?.S).toBe(w.clock.now().toISOString());
    expect((await w.tokens.list('ana'))[0]!.revoked_at).toBe(w.clock.now().toISOString());
  });

  it('its owner lists their tokens by public id, scope, kind, times and last use; never the token, never its hash', async () => {
    const w = await world();
    const later = (h: number) => new Date(w.clock.now().getTime() + h * 3_600_000);
    const a = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: later(24) });
    w.clock.advance(1000);
    const b = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt: later(2) });
    await w.tokens.issue({ owner: 'bo', scope: 'read', kind: 'session', expiresAt: later(2) });
    const listed = await w.tokens.list('ana');
    expect(listed.map((t) => t.id)).toEqual([a.id, b.id]);
    expect(listed[1]).toEqual({ id: b.id, owner: 'ana', scope: 'read', kind: 'session', created_at: '2026-09-29T12:00:01.000Z', expires_at: later(2).toISOString() });
    const text = JSON.stringify(listed);
    for (const t of [a.token, b.token]) {
      expect(text).not.toContain(t);
      expect(text).not.toContain(createHash('sha256').update(t).digest('hex'));
    }
    expect(await w.tokens.list('cy')).toEqual([]);
  });

  it('a token is revoked only by its owner: another\'s id, or one that doesn\'t exist, changes nothing', async () => {
    const w = await world();
    const a = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    expect(await w.tokens.revoke('bo', a.id)).toBe(false);
    expect(await w.tokens.revoke('ana', 'AAAAAAAAAAAAAAAA')).toBe(false);
    expect(await w.tokens.verify(a.token)).toMatchObject({ owner: 'ana' });
    expect((await w.tokens.list('ana'))[0]!.revoked_at).toBeUndefined();
  });

  it('last use is recorded at most once an hour, so a busy token costs one write an hour', async () => {
    const w = await world();
    const a = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: new Date(w.clock.now().getTime() + 24 * 3_600_000) });
    const sent: string[] = [];
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = ((cmd: { constructor: { name: string } }, ...rest: unknown[]) => (sent.push(cmd.constructor.name), (send as any)(cmd, ...rest))) as typeof w.ddb.send;
    const writes = () => sent.filter((c) => c !== 'GetItemCommand' && c !== 'QueryCommand').length;
    await w.tokens.verify(a.token);
    expect((await w.tokens.list('ana'))[0]!.last_used_at).toBe('2026-09-29T12:00:00.000Z');
    const once = writes();
    expect(once).toBeGreaterThan(0);
    w.clock.advance(59 * 60_000);
    await w.tokens.verify(a.token);
    expect(writes()).toBe(once);
    w.clock.advance(60_000);
    await w.tokens.verify(a.token);
    expect(writes()).toBeGreaterThan(once);
    expect((await w.tokens.list('ana'))[0]!.last_used_at).toBe('2026-09-29T13:00:00.000Z');
  });

  it('a failed last-use write never fails the request: the holder is still answered', async () => {
    const w = await world();
    const a = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt: new Date(w.clock.now().getTime() + 3_600_000) });
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = ((cmd: { constructor: { name: string } }, ...rest: unknown[]) =>
      cmd.constructor.name === 'UpdateItemCommand' ? Promise.reject(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' })) : (send as any)(cmd, ...rest)) as typeof w.ddb.send;
    expect(await w.tokens.verify(a.token)).toEqual({ owner: 'ana', scope: 'read', kind: 'session' });
  });

  it('only a read or publish scope, and an expiry in the future, can be issued', async () => {
    const w = await world();
    const later = new Date(w.clock.now().getTime() + 1000);
    await expect(w.tokens.issue({ owner: 'ana', scope: 'admin' as never, kind: 'personal', expiresAt: later })).rejects.toThrow();
    await expect(w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'personal', expiresAt: w.clock.now() })).rejects.toThrow();
  });
});
