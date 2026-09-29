// Getting a token, hosted (contract §1.1): sign_in_with_github checks a GitHub token with GitHub's own check for our
// OAuth app, then the login against the catalog's sign-in list, and answers a new catalog token (a session, 7 days, the
// scope asked for), shown once. Every refusal is unauthenticated and never says which check failed; GitHub unreachable is
// the catalog's own failure, never the person's. list_tokens and revoke_token act on the caller's own tokens only.

import { afterEach, describe, expect, it } from 'vitest';
import { OPERATIONS } from '../src/api.ts';
import { CatalogError } from '../src/errors.ts';
import { actAs } from '../src/local/index.ts';
import { openapi } from '../src/openapi.ts';
import { renderError } from '../src/render.ts';
import { Words } from '../src/words-file.ts';
import { errorOf, openTest } from './helpers.ts';
import { openHostedStandIn, type StandIn } from './hosted-stand-in.ts';

// GitHub's token formats: an OAuth app's user token (gho_) and the older 40 hex characters.
const OURS = `gho_${'a'.repeat(36)}`;
const OTHER_APP = `gho_${'b'.repeat(36)}`;
const DAY = 86_400_000;

let open: StandIn[] = [];
async function standIn(opts: Parameters<typeof openHostedStandIn>[0] = {}): Promise<StandIn> {
  const s = await openHostedStandIn({ github: (t) => (t === OURS ? 'Ana-Dev' : undefined), config: { signInLogins: ['ana-dev'] }, ...opts });
  open.push(s);
  return s;
}
afterEach(() => {
  for (const s of open) s.close();
  open = [];
});

describe('the token operations are hosted-only web operations', () => {
  it('sign_in_with_github takes no Bearer token; list_tokens reads; revoke_token changes', () => {
    const row = (op: string) => OPERATIONS[op]!;
    expect(['sign_in_with_github', 'list_tokens', 'revoke_token'].map((op) => [op, row(op).where, row(op).faces, row(op).effect, row(op).token])).toEqual([
      ['sign_in_with_github', 'hosted', ['web'], 'writes_catalog', 'none'],
      ['list_tokens', 'hosted', ['web'], 'reads', undefined],
      ['revoke_token', 'hosted', ['web'], 'writes_catalog', undefined],
    ]);
    const paths = (where: 'local' | 'hosted') => Object.keys((openapi(where) as any).paths);
    for (const op of ['sign_in_with_github', 'list_tokens', 'revoke_token']) {
      expect(paths('hosted')).toContain(`/api/v1/${op}`);
      expect(paths('local')).not.toContain(`/api/v1/${op}`);
    }
  });
});

describe('sign_in_with_github', () => {
  it('a token of our app for a login on the list: a session token of the scope asked for, for 7 days, shown once', async () => {
    const s = await standIn();
    const r = await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect(Object.keys(r).sort()).toEqual(['expires_at', 'id', 'scope', 'token']);
    expect(r.scope).toBe('read');
    const issued = s.tokens.byToken.get(r.token)!;
    expect(issued).toMatchObject({ id: r.id, owner: 'ana-dev', scope: 'read', kind: 'session', expires_at: r.expires_at });
    expect(Date.parse(r.expires_at) - Date.parse(issued.created_at)).toBeGreaterThanOrEqual(7 * DAY - 5_000);
    expect(Date.parse(r.expires_at) - Date.parse(issued.created_at)).toBeLessThanOrEqual(7 * DAY + 5_000);
    expect(await s.tokens.verify(r.token)).toEqual({ owner: 'ana-dev', scope: 'read', kind: 'session' });
    expect((await s.catalog.signIn({ github_token: OURS, scope: 'publish' })).scope).toBe('publish');
  });

  it('the login is compared as GitHub compares logins, whatever its case, and becomes the developer name in lowercase', async () => {
    const s = await standIn({ github: () => 'ANA-DEV', config: { signInLogins: ['Ana-Dev'] } });
    const r = await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect(s.tokens.byToken.get(r.token)!.owner).toBe('ana-dev');
  });

  it('another app\'s token (or a revoked one), a login not on the list, and an empty list are all unauthenticated, saying nothing more', async () => {
    const cases: [string, Parameters<typeof standIn>[0], string][] = [
      ['another app', {}, OTHER_APP],
      ['not on the list', { config: { signInLogins: ['someone-else'] } }, OURS],
      ['nobody may sign in', { config: { signInLogins: [] } }, OURS],
    ];
    for (const [what, opts, token] of cases) {
      const s = await standIn(opts);
      const e = await errorOf(() => s.catalog.signIn({ github_token: token, scope: 'publish' }));
      expect([what, e.code, e.data]).toEqual([what, 'unauthenticated', {}]);
      expect([what, s.tokens.byToken.size]).toEqual([what, 0]);
    }
  });

  it('a malformed GitHub token is refused before GitHub is asked', async () => {
    const s = await standIn();
    for (const bad of ['', 'x', 'gho_short', `gho_${'a'.repeat(36)}\n`, `ghp_${'!'.repeat(36)}`, 'a'.repeat(300)]) {
      const e = await errorOf(() => s.catalog.signIn({ github_token: bad, scope: 'read' }));
      expect([JSON.stringify(bad).slice(0, 30), e.code === 'unauthenticated' || e.code === 'invalid_request']).toEqual([JSON.stringify(bad).slice(0, 30), true]);
    }
    expect(s.githubCalls).toEqual([]);
  });

  it('GitHub unreachable is the catalog\'s failure (a bug-level error, never unauthenticated), and issues nothing', async () => {
    const s = await standIn({ github: () => 'down' });
    const e = await s.catalog.signIn({ github_token: OURS, scope: 'read' }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CatalogError);
    expect(s.tokens.byToken.size).toBe(0);
  });

  it('the scope is required: read or publish', async () => {
    const s = await standIn();
    const none = await errorOf(() => s.catalog.signIn({ github_token: OURS }));
    expect([none.code, none.data]).toMatchObject(['invalid_request', { field: 'scope', why: 'required' }]);
    expect((await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'admin' }))).code).toBe('invalid_request');
    expect(s.githubCalls).toEqual([]);
  });
});

describe('list_tokens and revoke_token: the caller\'s own tokens only', () => {
  it('lists the caller\'s tokens by id, never the token; revokes one of theirs; another\'s id or none at all is not_found {id}', async () => {
    const s = await standIn();
    const mine = await s.tokens.issue({ owner: 'dana', scope: 'publish', kind: 'personal', expiresAt: new Date(Date.parse('2026-10-28T00:00:00Z')) });
    const theirs = await s.tokens.issue({ owner: 'erin', scope: 'read', kind: 'session', expiresAt: new Date(Date.parse('2026-10-28T00:00:00Z')) });
    const listed = await s.catalog.listTokens({}, actAs('dana'));
    expect(listed.tokens.map((t) => t.id)).toEqual([mine.id]);
    expect(JSON.stringify(listed)).not.toContain(mine.token);
    expect(Object.keys(listed.tokens[0]!).sort()).toEqual(['created_at', 'expires_at', 'id', 'kind', 'scope']);

    for (const id of [theirs.id, 'no-such-id']) {
      const e = await errorOf(() => s.catalog.revokeToken({ id }, actAs('dana')));
      expect([e.code, e.data]).toEqual(['not_found', { id }]);
    }
    expect(await s.tokens.verify(theirs.token)).toMatchObject({ owner: 'erin' });
    expect(await s.catalog.revokeToken({ id: mine.id }, actAs('dana'))).toEqual({ id: mine.id });
    expect(await s.catalog.revokeToken({ id: mine.id }, actAs('dana'))).toEqual({ id: mine.id });
    expect(await s.tokens.verify(mine.token)).toBeUndefined();
    expect((await s.catalog.listTokens({}, actAs('dana'))).tokens[0]!.revoked_at).toEqual(expect.any(String));
  });

  it('nobody acting is unauthenticated', async () => {
    const s = await standIn();
    expect((await errorOf(() => s.catalog.listTokens({}, actAs(undefined)))).code).toBe('unauthenticated');
    expect((await errorOf(() => s.catalog.revokeToken({ id: 'x' }, actAs(undefined)))).code).toBe('unauthenticated');
  });

  it('not_found for a token says so without saying whose it is', () => {
    const s = Words.load();
    const text = renderError(s, new CatalogError('not_found', { id: 'abc' }));
    expect(text).toBe(s.format(s.word('errors').not_found_token, { id: 'abc' }));
  });
});

describe('where the catalog runs decides the ports', () => {
  it('a local catalog has no token operations', async () => {
    const { catalog } = await openTest({ identity: actAs('dana') });
    await expect(catalog.signIn({ github_token: OURS, scope: 'read' })).rejects.toThrow(/hosted only/);
    await expect(catalog.listTokens({})).rejects.toThrow(/hosted only/);
    catalog.close();
  });
});
