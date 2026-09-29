// Signing in with GitHub, hosted (contract §1.1): the one outbound call, to GitHub's check for tokens issued to our OAuth
// app (POST https://api.github.com/applications/{client_id}/token, basic auth with the app's id and secret), never
// GET /user, which takes any app's token. GitHub saying no is undefined; GitHub unreachable is thrown. Neither token nor
// the secret is ever in an error's message. A stand-in of GitHub answers here; nothing leaves this machine.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GITHUB_API, GITHUB_TIMEOUT_MS, HostedGitHubSignIn } from '../src/github.ts';

const TOKEN = `gho_${'t'.repeat(36)}`;
const CLIENT_ID = 'Iv1.0123456789abcdef';
const SECRET = 's'.repeat(40);

type Call = { url: string; method: string; headers: Record<string, string>; body: string; redirect: RequestRedirect | undefined };

/** GitHub as it answers the check: our app's token → 200 with the user's login; another's → 404. */
function github(answer: (call: Call) => Response | Promise<Response> | 'hang') {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), method: String(init.method), headers: Object.fromEntries(new Headers(init.headers).entries()), body: String(init.body), redirect: init.redirect };
    calls.push(call);
    const a = answer(call);
    if (a === 'hang') {
      return new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }))));
    }
    return a;
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const ours = () => new Response(JSON.stringify({ token: TOKEN, user: { login: 'Ana-Dev', id: 583231 }, app: { client_id: CLIENT_ID } }), { status: 200 });

function signIn(fetch: typeof globalThis.fetch, secret: () => Promise<string> = async () => SECRET, timeoutMs = 5000) {
  let t = Date.parse('2026-09-29T12:00:00Z');
  const clock = { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
  return { s: new HostedGitHubSignIn({ clientId: CLIENT_ID, secret, fetch, clock, timeoutMs }), clock };
}

describe('the GitHub check', () => {
  it('a token of our app: its login, from one POST to GitHub\'s check for our app, with our app\'s id and secret', async () => {
    const g = github(ours);
    expect(await signIn(g.fetch).s.login(TOKEN)).toEqual({ login: 'Ana-Dev', id: 583231 });
    expect(g.calls).toHaveLength(1);
    const [c] = g.calls;
    expect(c!.url).toBe(`https://api.github.com/applications/${CLIENT_ID}/token`);
    expect(c!.method).toBe('POST');
    // Its body holds the person's GitHub token, so a redirect is never followed (fetch throws on one).
    expect(c!.redirect).toBe('error');
    expect(c!.headers['authorization']).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64')}`);
    expect(JSON.parse(c!.body)).toEqual({ access_token: TOKEN });
    expect(GITHUB_API).toBe('https://api.github.com');
  });

  it("GitHub saying it isn't our app's token (404): undefined, and only that", async () => {
    expect(await signIn(github(() => new Response('{}', { status: 404 })).fetch).s.login(TOKEN)).toBeUndefined();
  });

  it("GitHub unreachable, failing, slow, refusing our app's own credentials, unable to check (422) or redirecting: thrown, never undefined, never naming a token or the secret", async () => {
    const cases: [string, (c: Call) => Response | 'hang'][] = [
      ['5xx', () => new Response('', { status: 502 })],
      ['our credentials refused', () => new Response('', { status: 401 })],
      ["can't check it (validation failed, or the endpoint spammed)", () => new Response('{}', { status: 422 })],
      ['a redirect', () => new Response('', { status: 302, headers: { location: 'https://elsewhere.test/' } })],
      ['no login in the answer', () => new Response('{"user":{"id":1}}', { status: 200 })],
      ['no id in the answer', () => new Response('{"user":{"login":"ana"}}', { status: 200 })],
      ['an id that is no whole number', () => new Response('{"user":{"login":"ana","id":"1"}}', { status: 200 })],
      ['an id of 0', () => new Response('{"user":{"login":"ana","id":0}}', { status: 200 })],
      ['network', () => { throw new TypeError('fetch failed'); }],
      ['slow', () => 'hang'],
    ];
    for (const [what, answer] of cases) {
      const e = await signIn(github(answer).fetch, undefined, 50).s.login(TOKEN).then(() => undefined, (x: unknown) => x);
      expect([what, e instanceof Error]).toEqual([what, true]);
      expect([what, String((e as Error).message)]).not.toEqual([what, expect.stringContaining(TOKEN)]);
      expect(String((e as Error).message)).not.toContain(SECRET);
    }
  });

  it('GitHub gets 5 seconds, when no other time is given', async () => {
    expect(GITHUB_TIMEOUT_MS).toBe(5000);
    const spy = vi.spyOn(AbortSignal, 'timeout');
    try {
      const g = github(ours);
      await new HostedGitHubSignIn({ clientId: CLIENT_ID, secret: async () => SECRET, fetch: g.fetch, clock: { now: () => new Date() } }).login(TOKEN);
      expect(spy.mock.calls).toEqual([[5000]]);
    } finally {
      spy.mockRestore();
    }
  });

  it('the secret is read once and kept for five minutes; a failed read is thrown', async () => {
    let reads = 0;
    const g = github(ours);
    const { s, clock } = signIn(g.fetch, async () => (reads++, SECRET));
    await s.login(TOKEN);
    clock.advance(4 * 60_000);
    await s.login(TOKEN);
    expect(reads).toBe(1);
    clock.advance(60_000);
    await s.login(TOKEN);
    expect(reads).toBe(2);
    const failing = signIn(g.fetch, async () => {
      throw Object.assign(new Error('AccessDenied'), { name: 'AccessDeniedException' });
    }).s;
    await expect(failing.login(TOKEN)).rejects.toThrow();
  });

  it('it\'s the only outbound call the hosted package makes', () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url));
    const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts'));
    const calling = files.filter((f) => /\bfetch\(|https?:\/\/(?!docs\.)/.test(readFileSync(join(src, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')));
    expect(calling).toEqual(['github.ts']);
  });
});
