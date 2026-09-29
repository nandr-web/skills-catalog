// Who's asking, hosted (contract §1.1, §9): every /api/v1 call carries `Authorization: Bearer <token>`, a sign-in session
// or a personal token; identity comes only from the token. No token, a malformed one, or one that's unknown, revoked or
// expired is unauthenticated (401) before anything is looked up; the local acting-as header is invalid_request (400,
// why token_only), also before any lookup; a read-scope token changing the catalog is forbidden (why read_scope), an
// operation's answer, from the operation's own row.

import { describe, expect, it } from 'vitest';
import { OPERATIONS, isCatalogError, webRow } from '@skills-catalog/core';
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

const refusal = (r: Awaited<ReturnType<typeof whoIsAsking>>) => {
  if (r.kind !== 'refused') throw new Error(`expected a refusal, got ${r.kind}`);
  return { status: r.status, error: r.error.toJSON() };
};

describe("who's asking", () => {
  it('a Bearer token that verifies is its holder', async () => {
    const t = tokens();
    expect(await whoIsAsking({ authorization: 'Bearer t-ana' }, t)).toEqual({ kind: 'holder', holder: ANA });
    expect(await whoIsAsking({ authorization: 'bearer t-bo' }, t)).toEqual({ kind: 'holder', holder: BO });
  });

  it('no Authorization header, or one that is not a single Bearer token, is unauthenticated (401) before any lookup', async () => {
    const t = tokens();
    for (const authorization of [undefined, '', 'Bearer', 'Bearer ', 'Basic YW5hOnB3', 'Token t-ana', 'Bearer t-ana extra', 'Bearert-ana', 'Bearer t-ana, Bearer t-bo']) {
      expect(refusal(await whoIsAsking({ authorization }, t)), String(authorization)).toEqual({ status: 401, error: { code: 'unauthenticated' } });
    }
    expect(t.looked).toEqual([]);
  });

  it('an unknown, revoked or expired token (the store says nobody) is unauthenticated (401)', async () => {
    const t = tokens();
    expect(refusal(await whoIsAsking({ authorization: 'Bearer t-nobody' }, t))).toEqual({ status: 401, error: { code: 'unauthenticated' } });
    expect(t.looked).toEqual(['t-nobody']);
  });

  it('the local acting-as header is invalid_request, token_only (400), before any lookup, even with a good token or none', async () => {
    const t = tokens();
    for (const headers of [{ authorization: 'Bearer t-ana', 'x-skills-catalog-as': 'bo' }, { 'x-skills-catalog-as': '' }]) {
      const r = refusal(await whoIsAsking(headers, t));
      expect(r.status).toBe(400);
      expect(r.error).toEqual({ code: 'invalid_request', field: 'X-Skills-Catalog-As', why: 'token_only' });
    }
    expect(t.looked).toEqual([]);
  });
});

describe('what a holder may run', () => {
  // The operations a hosted catalog's web face serves, by the API's one rule.
  const webRows = Object.values(OPERATIONS).filter((o) => webRow(o, 'hosted'));

  it('every operation the web face serves either reads or changes the catalog, never this machine', () => {
    expect(webRows.length).toBeGreaterThan(0);
    for (const o of webRows) expect(['reads', 'writes_catalog'], o.name).toContain(o.effect);
  });

  it('a read-scope token may run what reads, and is forbidden (read_scope) what changes the catalog', () => {
    for (const o of webRows) {
      const e = mayRun(BO, o.name);
      if (o.effect === 'reads') expect(e, o.name).toBeUndefined();
      else {
        expect(isCatalogError(e, 'forbidden'), o.name).toBe(true);
        expect(e!.toJSON()).toEqual({ code: 'forbidden', why: 'read_scope' });
      }
    }
  });

  it('a publish-scope token may run all of them', () => {
    for (const o of webRows) expect(mayRun(ANA, o.name), o.name).toBeUndefined();
  });

  it('an operation that is not a row is refused, never allowed by default', () => {
    expect(() => mayRun(ANA, 'constructor')).toThrow();
    expect(() => mayRun(BO, 'no_such_operation')).toThrow();
    // A row the hosted web face doesn't serve (it changes this machine) is never reached here either.
    expect(OPERATIONS['install_shared_skill']!.effect).toBe('writes_machine');
    expect(() => mayRun(ANA, 'install_shared_skill')).toThrow();
  });
});
