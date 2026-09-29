// Who's asking, hosted (contract §1.1): every /api/v1 call carries `Authorization: Bearer <token>`, a sign-in session or a
// personal token; identity comes only from the token. No token, a malformed one, or one that's unknown, revoked or
// expired is refused before anything is looked up; the local acting-as header is refused; a read-scope token can't
// change the catalog.

import { describe, expect, it } from 'vitest';
import { isCatalogError } from '@skills-catalog/core';
import { mayRun, whoIsAsking } from '../src/api/who.ts';
import type { TokenHolder } from '../src/index.ts';

const ANA: TokenHolder = { owner: 'ana', scope: 'publish', kind: 'personal' };
const BO: TokenHolder = { owner: 'bo', scope: 'read', kind: 'session' };

/** A token store that knows two tokens and counts every lookup. */
function tokens() {
  const known = new Map<string, TokenHolder>([['t-ana', ANA], ['t-bo', BO]]);
  const looked: string[] = [];
  return { looked, verify: async (t: string) => (looked.push(t), known.get(t)) };
}

describe("who's asking", () => {
  it('a Bearer token that verifies is its holder', async () => {
    const t = tokens();
    expect(await whoIsAsking({ authorization: 'Bearer t-ana' }, t)).toEqual({ kind: 'holder', holder: ANA });
    expect(await whoIsAsking({ authorization: 'bearer t-bo' }, t)).toEqual({ kind: 'holder', holder: BO });
  });

  it('no Authorization header, or one that is not a Bearer token, is 401 before any lookup', async () => {
    const t = tokens();
    for (const authorization of [undefined, '', 'Bearer', 'Bearer ', 'Basic YW5hOnB3', 'Token t-ana', 'Bearer t-ana extra', 'Bearert-ana']) {
      expect(await whoIsAsking({ authorization }, t)).toMatchObject({ kind: 'refused', status: 401 });
    }
    expect(t.looked).toEqual([]);
  });

  it('an unknown, revoked or expired token (the store says nobody) is 401', async () => {
    const t = tokens();
    expect(await whoIsAsking({ authorization: 'Bearer t-nobody' }, t)).toMatchObject({ kind: 'refused', status: 401 });
    expect(t.looked).toEqual(['t-nobody']);
  });

  it('the local acting-as header is refused when hosted, before any lookup, even with a good token', async () => {
    const t = tokens();
    for (const as of ['bo', '']) {
      expect(await whoIsAsking({ authorization: 'Bearer t-ana', 'x-skills-catalog-as': as }, t)).toEqual({ kind: 'refused', status: 400 });
    }
    expect(t.looked).toEqual([]);
  });

  it('a 401 carries the Bearer challenge', async () => {
    const r = await whoIsAsking({}, tokens());
    expect(r.kind === 'refused' && r.headers).toEqual({ 'www-authenticate': 'Bearer' });
  });
});

describe('what a holder may run', () => {
  it('a read-scope token may read but not change the catalog: forbidden, nothing done', () => {
    expect(mayRun(BO, 'read')).toBeUndefined();
    const e = mayRun(BO, 'publish');
    expect(isCatalogError(e, 'forbidden')).toBe(true);
    expect(e!.toJSON()).toEqual({ code: 'forbidden' });
  });

  it('a publish-scope token may do both', () => {
    expect(mayRun(ANA, 'read')).toBeUndefined();
    expect(mayRun(ANA, 'publish')).toBeUndefined();
  });
});
