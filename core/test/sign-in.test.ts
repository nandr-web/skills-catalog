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
import { holding, openHostedStandIn, type StandIn } from './hosted-stand-in.ts';

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

  it('a GitHub token the schema takes but of no GitHub shape is unauthenticated, saying nothing more, before GitHub is asked', async () => {
    const s = await standIn();
    for (const bad of ['', 'x', 'gho_short', `gho_${'a'.repeat(36)}\n`, `ghp_${'!'.repeat(36)}`, 'a'.repeat(255)]) {
      const e = await errorOf(() => s.catalog.signIn({ github_token: bad, scope: 'read' }));
      expect([JSON.stringify(bad).slice(0, 30), e.code, e.data]).toEqual([JSON.stringify(bad).slice(0, 30), 'unauthenticated', {}]);
    }
    expect(s.githubCalls).toEqual([]);
  });

  it("a GitHub token over the schema's 255 characters is the schema's invalid_request, before GitHub is asked", async () => {
    const s = await standIn();
    const e = await errorOf(() => s.catalog.signIn({ github_token: 'a'.repeat(256), scope: 'read' }));
    expect([e.code, (e.data as { field?: string }).field]).toEqual(['invalid_request', 'github_token']);
    expect(s.githubCalls).toEqual([]);
  });

  it("with nobody on the sign-in list, GitHub isn't asked at all", async () => {
    const s = await standIn({ config: { signInLogins: [] } });
    const e = await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'read' }));
    expect([e.code, e.data]).toEqual(['unauthenticated', {}]);
    expect(s.githubCalls).toEqual([]);
  });

  it("a session lasts the catalog's sessionDays", async () => {
    const s = await standIn({ config: { signInLogins: ['ana-dev'], sessionDays: 2 } });
    const r = await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    const lasts = Date.parse(r.expires_at) - Date.parse(s.tokens.byToken.get(r.token)!.created_at);
    expect(lasts).toBeGreaterThanOrEqual(2 * DAY - 5_000);
    expect(lasts).toBeLessThanOrEqual(2 * DAY + 5_000);
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

describe("a login is bound to GitHub's numeric id", () => {
  it('the first sign-in records the id; a later one for the login with another id (a renamed or re-registered account) is refused, the record unchanged', async () => {
    let id = 11;
    const s = await standIn({ github: (t) => (t === OURS ? { login: 'Ana-Dev', id } : undefined) });
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect([...s.tokens.bindings]).toEqual([['ana-dev', 11]]);
    id = 12;
    const e = await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'read' }));
    expect([e.code, e.data]).toEqual(['unauthenticated', {}]);
    expect([...s.tokens.bindings]).toEqual([['ana-dev', 11]]);
    expect(s.tokens.byToken.size).toBe(1);
    id = 11;
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect(s.tokens.byToken.size).toBe(2);
  });

  it('the login binds by its lowercase, so ANA-DEV and ana-dev share one record', async () => {
    let login = 'ANA-DEV';
    const s = await standIn({ github: () => ({ login, id: 11 }) });
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    login = 'ana-dev';
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect([...s.tokens.bindings]).toEqual([['ana-dev', 11]]);
    expect(s.tokens.calls.filter((c) => c.startsWith('bindLogin'))).toEqual(['bindLogin ana-dev 11', 'bindLogin ana-dev 11']);
  });

  it('login:id on the list pins the id from the start: another id is refused, and nothing is recorded either way', async () => {
    let id = 8;
    const s = await standIn({ github: () => ({ login: 'ana-dev', id }), config: { signInLogins: ['Ana-Dev:7'] } });
    const e = await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'read' }));
    expect([e.code, e.data]).toEqual(['unauthenticated', {}]);
    id = 7;
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect(s.tokens.calls.filter((c) => c.startsWith('bindLogin'))).toEqual([]);
    expect(s.tokens.byToken.size).toBe(1);
  });

  it.each([':', 'bob:', 'bob:x', 'bob:1:2', ':7', 'bob:-1', 'bob:1.5'])('a sign-in list entry %j fails the catalog at open', async (entry) => {
    await expect(openHostedStandIn({ config: { signInLogins: ['ana-dev', entry] } })).rejects.toThrow(/sign-in list/);
  });

  it.each([
    [['bob', 'Bob:7']],
    [['bob:5', 'bob:6']],
    [['ana-dev', 'BOB', 'bob']],
  ])('a login listed twice, whatever its case or pin (%j), fails the catalog at open, naming the later entry by its place', async (list) => {
    await expect(openHostedStandIn({ config: { signInLogins: list } })).rejects.toThrow(new RegExp(`sign-in list.*entry ${list.length}\\b`));
  });

  it("an id from GitHub's port that isn't a positive whole number is the port's bug: thrown, never compared or recorded", async () => {
    for (const id of [0, -1, 1.5, Number.NaN, 2 ** 53]) {
      const s = await standIn({ github: () => ({ login: 'ana-dev', id }) });
      const e = await s.catalog.signIn({ github_token: OURS, scope: 'read' }).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect([id, e instanceof Error && !(e instanceof CatalogError)]).toEqual([id, true]);
      expect(s.tokens.calls).toEqual([]);
    }
  });
});

describe('at most so many live tokens a person (contract §1.1)', () => {
  it('50 by default', async () => {
    const s = await standIn();
    expect(s.catalog.config.maxLiveTokens).toBe(50);
  });

  it("at the limit a sign-in issues nothing and answers forbidden {why: too_many_tokens, limit}; revoked and expired tokens don't count", async () => {
    const s = await standIn({ config: { signInLogins: ['ana-dev'], maxLiveTokens: 2 } });
    const first = await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    const e = await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'read' }));
    expect([e.code, e.data]).toEqual(['forbidden', { why: 'too_many_tokens', limit: 2 }]);
    expect(s.tokens.calls.filter((c) => c.startsWith('issue'))).toHaveLength(2);
    // One revoked, and one already expired (its expiry a second before now): neither counts, so one more fits.
    await s.catalog.revokeToken({ id: first.id }, holding('ana-dev', 'read'));
    await s.tokens.issue({ owner: 'ana-dev', scope: 'read', kind: 'personal', expiresAt: new Date(Date.parse(s.tokens.byToken.get(first.token)!.created_at) - 1000) });
    expect(await s.tokens.liveCount('ana-dev')).toBe(1);
    await s.catalog.signIn({ github_token: OURS, scope: 'read' });
    expect(await s.tokens.liveCount('ana-dev')).toBe(2);
    expect((await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'read' }))).code).toBe('forbidden');
  });

  it('checked only after every other check: a login not on the list, at its limit, is unauthenticated, not forbidden', async () => {
    const s = await standIn({ config: { signInLogins: ['someone-else'], maxLiveTokens: 0 } });
    const e = await errorOf(() => s.catalog.signIn({ github_token: OURS, scope: 'read' }));
    expect([e.code, e.data]).toEqual(['unauthenticated', {}]);
  });

  it("the refusal's sentence is the words file's, with the limit in it", () => {
    const w = Words.load();
    const text = renderError(w, new CatalogError('forbidden', { why: 'too_many_tokens', limit: 50 }));
    expect(text).toBe(w.format(w.word('errors').forbidden_too_many_tokens, { limit: 50 }));
    expect(text).toContain('50');
  });
});

describe('the token rows', () => {
  it('signing in is the only operation without a Bearer token, and the hosted OpenAPI says so (security: [])', () => {
    expect(Object.values(OPERATIONS).filter((o) => o.token === 'none').map((o) => o.name)).toEqual(['sign_in_with_github']);
    const paths = (openapi('hosted') as any).paths;
    expect(paths['/api/v1/sign_in_with_github'].post.security).toEqual([]);
    expect(paths['/api/v1/list_tokens'].post.security).toEqual([{ bearer: [] }]);
  });

  it("revoke_token checks the caller's scope itself; no other row does", () => {
    expect(Object.values(OPERATIONS).filter((o) => o.checksScope).map((o) => o.name)).toEqual(['revoke_token']);
  });
});

describe("list_tokens and revoke_token: the caller's own tokens only", () => {
  const LATER = new Date(Date.parse('2026-10-28T00:00:00Z'));

  it("lists the caller's tokens by id, never the token; revokes one of theirs; another's id or none at all is not_found {id}", async () => {
    const s = await standIn();
    const mine = await s.tokens.issue({ owner: 'dana', scope: 'publish', kind: 'personal', expiresAt: LATER });
    const theirs = await s.tokens.issue({ owner: 'erin', scope: 'read', kind: 'session', expiresAt: LATER });
    const listed = await s.catalog.listTokens({}, holding('dana', 'publish'));
    expect(listed.tokens.map((t) => t.id)).toEqual([mine.id]);
    expect(JSON.stringify(listed)).not.toContain(mine.token);
    expect(Object.keys(listed.tokens[0]!).sort()).toEqual(['created_at', 'expires_at', 'id', 'kind', 'scope']);

    for (const id of [theirs.id, 'nosuchid00000000']) {
      const e = await errorOf(() => s.catalog.revokeToken({ id }, holding('dana', 'publish')));
      expect([e.code, e.data]).toEqual(['not_found', { id }]);
    }
    expect(await s.tokens.verify(theirs.token)).toMatchObject({ owner: 'erin' });
    expect(await s.catalog.revokeToken({ id: mine.id }, holding('dana', 'publish'))).toEqual({ id: mine.id });
    expect(await s.catalog.revokeToken({ id: mine.id }, holding('dana', 'publish'))).toEqual({ id: mine.id });
    expect(await s.tokens.verify(mine.token)).toBeUndefined();
    expect((await s.catalog.listTokens({}, holding('dana', 'publish'))).tokens[0]!.revoked_at).toEqual(expect.any(String));
  });

  it("an id that isn't a token id's shape is invalid_request {field: id, why: not_a_token_id}, never repeating it, before anything is looked up", async () => {
    const s = await standIn();
    const pasted = `tok-${'x'.repeat(40)}`;
    for (const id of ['', 'no-such-id', pasted, 'a'.repeat(15), 'a'.repeat(17), 'aaaaaaaaaaaaaaa/', 'a'.repeat(5000)]) {
      const e = await errorOf(() => s.catalog.revokeToken({ id }, holding('dana', 'publish')));
      expect([id.slice(0, 20), e.code, e.data]).toEqual([id.slice(0, 20), 'invalid_request', { field: 'id', why: 'not_a_token_id' }]);
      if (id) expect(JSON.stringify(e.data)).not.toContain(id);
    }
    expect(s.tokens.calls).toEqual([]);
  });

  it('a read token revokes read tokens of its own; revoking a publish token needs the publish scope (forbidden {why: read_scope}), and it stays good', async () => {
    const s = await standIn();
    const read = await s.tokens.issue({ owner: 'dana', scope: 'read', kind: 'session', expiresAt: LATER });
    const publish = await s.tokens.issue({ owner: 'dana', scope: 'publish', kind: 'personal', expiresAt: LATER });
    const e = await errorOf(() => s.catalog.revokeToken({ id: publish.id }, holding('dana', 'read')));
    expect([e.code, e.data]).toEqual(['forbidden', { why: 'read_scope' }]);
    expect(await s.tokens.verify(publish.token)).toMatchObject({ scope: 'publish' });
    expect(await s.catalog.revokeToken({ id: read.id }, holding('dana', 'read'))).toEqual({ id: read.id });
    expect(await s.catalog.revokeToken({ id: publish.id }, holding('dana', 'publish'))).toEqual({ id: publish.id });
    expect(await s.tokens.verify(publish.token)).toBeUndefined();
  });

  it("a read token asking about another's publish token is not_found, the same as none, so no other owner's ids or scopes leak", async () => {
    const s = await standIn();
    const theirs = await s.tokens.issue({ owner: 'erin', scope: 'publish', kind: 'personal', expiresAt: LATER });
    const e = await errorOf(() => s.catalog.revokeToken({ id: theirs.id }, holding('dana', 'read')));
    expect([e.code, e.data]).toEqual(['not_found', { id: theirs.id }]);
  });

  it('a hosted caller always has a scope: one without is a bug (thrown, never read as no limit)', async () => {
    const s = await standIn();
    const mine = await s.tokens.issue({ owner: 'dana', scope: 'publish', kind: 'personal', expiresAt: LATER });
    const e = await s.catalog.revokeToken({ id: mine.id }, actAs('dana')).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(CatalogError);
    expect(await s.tokens.verify(mine.token)).toMatchObject({ owner: 'dana' });
  });

  it('nobody acting is unauthenticated', async () => {
    const s = await standIn();
    expect((await errorOf(() => s.catalog.listTokens({}, actAs(undefined)))).code).toBe('unauthenticated');
    expect((await errorOf(() => s.catalog.revokeToken({ id: 'nosuchid00000000' }, actAs(undefined)))).code).toBe('unauthenticated');
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
