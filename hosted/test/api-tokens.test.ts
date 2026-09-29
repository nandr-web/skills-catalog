// The token operations through the hosted transport (contract §1.1 "Getting a token, hosted"), on the stand-in with the
// real token store: a read token revokes read tokens of its own and is refused a publish one; an id of no token id's
// shape is refused without being repeated; a sign-in at the limit of live tokens issues nothing. Every caller the
// transport hands a token operation to carries its token's scope.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { Catalog, OPERATIONS, Words, actAs, randomIds, type Identity } from '@skills-catalog/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHostedHandler, type HostedRequest } from '../src/api/handler.ts';
import { createStores, HostedBlobLinks, HostedEvents, HostedStorage, HostedTokenStore, S3SearchIndex, type Place } from '../src/index.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

const words = Words.load();
const GITHUB = `gho_${'a'.repeat(36)}`;
const LATER = new Date(Date.parse('2026-10-29T12:00:00Z'));
let n = 0;
const open: Catalog[] = [];
afterAll(() => {
  for (const c of open) c.close();
});

async function world(config: { signInLogins: string[]; maxLiveTokens?: number } = { signInLogins: ['ana'] }) {
  const place: Place = { table: `api-tokens-${++n}`, bucket: `api-tokens-${n}` };
  const ddb = new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint });
  const s3 = new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' });
  await createStores(ddb, s3, place);
  const clock = { now: () => new Date('2026-09-29T12:00:00Z') };
  const tokens = new HostedTokenStore({ ddb, place, clock });
  const catalog = await Catalog.open({
    where: 'hosted',
    links: new HostedBlobLinks({ s3, place, clock }),
    tokens,
    signIn: { login: async (t) => (t === GITHUB ? { login: 'ana', id: 7 } : undefined) },
    storage: new HostedStorage({ ddb, s3, place, clock }),
    index: new S3SearchIndex({ s3, place }),
    events: new HostedEvents({ ddb, place }),
    identity: actAs(undefined),
    clock,
    ids: randomIds,
    config,
    close: () => {
      ddb.destroy();
      s3.destroy();
    },
  });
  open.push(catalog);
  const handler = createHostedHandler({ catalog, tokens, words, origin: { allows: async () => true } });
  const post = async (op: string, body: unknown, token?: string) => {
    const req: HostedRequest = { method: 'POST', path: `/api/v1/${op}`, headers: token ? { authorization: `Bearer ${token}` } : {}, body: new TextEncoder().encode(JSON.stringify(body)) };
    const r = await handler.handle(req);
    return { status: r.status, text: String(r.body), json: JSON.parse(String(r.body)) as { ok: boolean; data?: any; error?: any; words?: any } };
  };
  return { tokens, post };
}

describe('the token operations, through the hosted transport', () => {
  it('a read token revokes a read token of its own, and is refused a publish one (forbidden, read_scope), which stays good', async () => {
    const w = await world();
    const reader = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt: LATER });
    const other = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt: LATER });
    const pub = await w.tokens.issue({ owner: 'ana', scope: 'publish', kind: 'personal', expiresAt: LATER });
    const refused = await w.post('revoke_token', { id: pub.id }, reader.token);
    expect([refused.status, refused.json.ok, refused.json.error]).toEqual([200, false, { code: 'forbidden', why: 'read_scope' }]);
    expect(refused.json.words.error).toBe(words.format(words.word('errors').forbidden_read_scope, {}));
    expect(await w.tokens.verify(pub.token)).toMatchObject({ scope: 'publish' });
    const done = await w.post('revoke_token', { id: other.id }, reader.token);
    expect([done.status, done.json.ok, done.json.data]).toEqual([200, true, { id: other.id }]);
    expect(await w.tokens.verify(other.token)).toBeUndefined();
    const withPublish = await w.post('revoke_token', { id: pub.id }, pub.token);
    expect(withPublish.json.ok).toBe(true);
  });

  it("an id of no token id's shape (a pasted token, say) is invalid_request, not_a_token_id, and the answer never repeats it", async () => {
    const w = await world();
    const reader = await w.tokens.issue({ owner: 'ana', scope: 'read', kind: 'session', expiresAt: LATER });
    const r = await w.post('revoke_token', { id: reader.token }, reader.token);
    expect(r.json.error).toEqual({ code: 'invalid_request', field: 'id', why: 'not_a_token_id' });
    expect(r.text.split(reader.token).length).toBe(1);
    expect(await w.tokens.verify(reader.token)).toMatchObject({ owner: 'ana' });
  });

  it('a sign-in at the limit of live tokens issues nothing: forbidden, too_many_tokens, with the limit and its sentence', async () => {
    const w = await world({ signInLogins: ['ana'], maxLiveTokens: 1 });
    const first = await w.post('sign_in_with_github', { github_token: GITHUB, scope: 'read' });
    expect(first.json.ok).toBe(true);
    const second = await w.post('sign_in_with_github', { github_token: GITHUB, scope: 'read' });
    expect(second.json.error).toEqual({ code: 'forbidden', why: 'too_many_tokens', limit: 1 });
    expect(second.json.words.error).toBe(words.format(words.word('errors').forbidden_too_many_tokens, { limit: 1 }));
    expect(await w.tokens.liveCount('ana')).toBe(1);
  });
});

describe('the transport gives every token holder its scope', () => {
  it('each operation that acts as someone gets an identity whose scope is the token\'s, never undefined', async () => {
    const seen: [string, string | undefined][] = [];
    const catalog = new Proxy(
      {},
      {
        get: (_, k) =>
          k === 'where'
            ? 'hosted'
            : async (_input: unknown, identity?: Identity) => {
                if (identity && typeof identity === 'object') seen.push([String(k), await identity.scope?.()]);
                return {};
              },
      },
    );
    for (const scope of ['read', 'publish'] as const) {
      const handler = createHostedHandler({ catalog: catalog as never, tokens: { verify: async () => ({ owner: 'ana', scope, kind: 'personal' }) }, words, origin: { allows: async () => true } });
      const acting = Object.values(OPERATIONS).filter((o) => o.acts && o.faces.includes('web') && (scope === 'publish' || o.effect === 'reads' || o.checksScope));
      expect(acting.length).toBeGreaterThan(0);
      for (const o of acting) {
        await handler.handle({ method: 'POST', path: `/api/v1/${o.name}`, headers: { authorization: 'Bearer t' }, body: new TextEncoder().encode('{}') });
      }
    }
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(([, s]) => s === undefined)).toEqual([]);
  });
});
