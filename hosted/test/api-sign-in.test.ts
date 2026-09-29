// Signing in, hosted (contract §1.1): sign_in_with_github is the one operation called without a Bearer token, since it's
// how one is got; the origin guard and the acting-as refusal still come first, and a Bearer token sent along is never
// looked up. Every other operation, the token operations included, still needs a token.

import { Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { createHostedHandler, type HostedRequest } from '../src/api/handler.ts';
import { HostedGitHubSignIn } from '../src/github.ts';

const words = Words.load();
const GITHUB = `gho_${'a'.repeat(36)}`;

function world(origin = true) {
  const called: [string, unknown][] = [];
  const looked: string[] = [];
  const catalog = new Proxy(
    {},
    {
      get: (_, k) =>
        k === 'where'
          ? 'hosted'
          : (...args: unknown[]) => {
          called.push([String(k), args[0]]);
          return Promise.resolve({ token: 'issued', id: 'id1', scope: 'read', expires_at: '2026-10-06T12:00:00.000Z' });
        },
    },
  );
  const handler = createHostedHandler({
    catalog: catalog as never,
    tokens: { verify: async (t) => (looked.push(t), undefined) },
    words,
    origin: { allows: async () => origin },
  });
  return { handler, called, looked };
}

const post = (op: string, body: unknown, headers: Record<string, string> = {}): HostedRequest => ({
  method: 'POST',
  path: `/api/v1/${op}`,
  headers,
  body: new TextEncoder().encode(JSON.stringify(body)),
});

describe('sign_in_with_github, hosted', () => {
  it('needs no Bearer token: the catalog answers it', async () => {
    const w = world();
    const r = await w.handler.handle(post('sign_in_with_github', { github_token: GITHUB, scope: 'read' }));
    expect(r.status).toBe(200);
    expect(JSON.parse(String(r.body))).toMatchObject({ ok: true, data: { token: 'issued' } });
    expect(w.called.map(([k]) => k)).toEqual(['signIn']);
  });

  it('a Bearer token sent along is never looked up', async () => {
    const w = world();
    await w.handler.handle(post('sign_in_with_github', { github_token: GITHUB, scope: 'read' }, { authorization: 'Bearer something' }));
    expect(w.looked).toEqual([]);
    expect(w.called.map(([k]) => k)).toEqual(['signIn']);
  });

  it('the origin guard and the acting-as refusal still come first', async () => {
    const edge = world(false);
    expect((await edge.handler.handle(post('sign_in_with_github', { github_token: GITHUB, scope: 'read' }))).status).toBe(403);
    const acting = world();
    expect((await acting.handler.handle(post('sign_in_with_github', { github_token: GITHUB, scope: 'read' }, { 'x-skills-catalog-as': 'ana' }))).status).toBe(400);
    expect([...edge.called, ...acting.called]).toEqual([]);
  });

  it('every other operation, the token operations too, still needs a token', async () => {
    const w = world();
    for (const op of ['list_tokens', 'revoke_token', 'search_shared_skills']) expect([op, (await w.handler.handle(post(op, {}))).status]).toEqual([op, 401]);
    expect(w.called).toEqual([]);
  });

  it('no token, GitHub\'s or ours, and never the app\'s secret, reaches the log, GitHub down or not', async () => {
    const secret = 'S'.repeat(40);
    for (const down of [true, false]) {
      const logged: string[] = [];
      const gh = new HostedGitHubSignIn({
        clientId: 'Iv1.0123456789abcdef',
        secret: async () => secret,
        clock: { now: () => new Date() },
        fetch: (async () => (down ? new Response('', { status: 502 }) : new Response(JSON.stringify({ user: { login: 'ana', id: 7 } }), { status: 200 }))) as unknown as typeof fetch,
      });
      const catalog = { where: 'hosted', signIn: async (input: { github_token: string }) => ((await gh.login(input.github_token)), { token: 'catalog-token-issued', id: 'i', scope: 'read', expires_at: 'x' }) };
      const handler = createHostedHandler({ catalog: catalog as never, tokens: { verify: async () => undefined }, words, origin: { allows: async () => true }, log: (l) => logged.push(l) });
      const r = await handler.handle(post('sign_in_with_github', { github_token: GITHUB, scope: 'read' }));
      expect(JSON.parse(String(r.body))).toMatchObject(down ? { ok: false, error: { code: 'internal_error' } } : { ok: true, data: { token: 'catalog-token-issued' } });
      expect(logged.length).toBe(down ? 1 : 0);
      for (const l of logged) for (const never of [GITHUB, secret, 'catalog-token-issued']) expect(l).not.toContain(never);
    }
  });
});
