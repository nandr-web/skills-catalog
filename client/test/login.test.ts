// skills-catalog login / logout (contract §1.1): GitHub's device flow, then the catalog's sign_in_with_github; only the
// catalog's token is saved (0600, in the client's own folder), never GitHub's. GitHub and the catalog are fakes here.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runLogin, runLogout } from '../src/cli/login.ts';
import { catalogToken, settingsFrom } from '../src/settings.ts';
import { place } from './server.ts';

type Call = { url: string; body: any };
function world(o: { pending?: number; github?: 'refuses'; catalog?: 'refuses' } = {}) {
  const p = place();
  const settings = settingsFrom({ SKILLS_HOME: join(p.dir, 'home'), SKILLS_CATALOG: 'https://catalog.test' }, p.dir);
  const calls: Call[] = [];
  let pending = o.pending ?? 1;
  const http = (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ url, body });
    const json = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    if (url === 'https://github.com/login/device/code') return json({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', interval: 5, expires_in: 900 });
    if (url === 'https://github.com/login/oauth/access_token') {
      if (o.github === 'refuses') return json({ error: 'access_denied' });
      return pending-- > 0 ? json({ error: 'authorization_pending' }) : json({ access_token: 'gho_' + 'a'.repeat(36) });
    }
    if (url === 'https://catalog.test/api/v1/sign_in_with_github') {
      if (o.catalog === 'refuses') return json({ ok: false, error: { code: 'unauthenticated' }, words: { error: 'That GitHub account may not sign in here.' } });
      return json({ ok: true, data: { token: 'catalog-token-0123456789', id: 'i', scope: body.scope, expires_at: '2026-10-07T00:00:00Z' } });
    }
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  const out: string[] = [];
  const err: string[] = [];
  const io = (stdin = '') => ({ settings, env: { SKILLS_GITHUB_CLIENT_ID: 'Iv1.test' }, stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t), readStdin: async () => stdin, fetch: http, sleep: async () => {} });
  return { p, settings, calls, out, err, io };
}

describe('skills-catalog login', () => {
  it("signs in with GitHub's device code, trades GitHub's token for the catalog's, and saves only the catalog's (0600)", async () => {
    const w = world({ pending: 2 });
    expect(await runLogin([], w.io())).toBe(0);
    expect(w.out.join('')).toContain('ABCD-1234');
    const signIn = w.calls.find((c) => c.url.endsWith('/sign_in_with_github'))!;
    expect(signIn.body).toEqual({ github_token: 'gho_' + 'a'.repeat(36), scope: 'publish' });
    const file = join(w.settings.home, 'token');
    expect(readFileSync(file, 'utf8')).toBe('catalog-token-0123456789\n');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(w.settings.home).mode & 0o777).toBe(0o700);
    expect(readFileSync(file, 'utf8')).not.toContain('gho_');
    expect(catalogToken(w.settings)).toBe('catalog-token-0123456789');
  });

  it('--scope read asks for a read token', async () => {
    const w = world();
    expect(await runLogin(['--scope', 'read'], w.io())).toBe(0);
    expect(w.calls.find((c) => c.url.endsWith('/sign_in_with_github'))!.body.scope).toBe('read');
  });

  it('saves nothing when GitHub or the catalog refuses, and says why', async () => {
    for (const o of [{ github: 'refuses' as const }, { catalog: 'refuses' as const }]) {
      const w = world(o);
      expect(await runLogin([], w.io())).toBe(1);
      expect(existsSync(join(w.settings.home, 'token'))).toBe(false);
      expect(w.err.join('')).toMatch(o.github ? /access_denied/ : /may not sign in here/);
    }
  });

  it('refuses a local catalog, and needs the client id', async () => {
    const w = world();
    expect(await runLogin([], { ...w.io(), settings: { ...w.settings, catalog: 'file:///tmp/c' } })).toBe(1);
    expect(await runLogin([], { ...w.io(), env: {} })).toBe(1);
    expect(w.err.join('')).toContain('SKILLS_GITHUB_CLIENT_ID');
    expect(w.calls).toEqual([]);
  });

  it('--with-token saves a token from stdin; logout deletes it; SKILLS_TOKEN wins over the file', async () => {
    const w = world();
    expect(await runLogin(['--with-token'], w.io('personal-token-abcdefgh\n'))).toBe(0);
    expect(catalogToken(w.settings)).toBe('personal-token-abcdefgh');
    expect(catalogToken({ ...w.settings, token: 'from-env' })).toBe('from-env');
    expect(runLogout(w.io())).toBe(0);
    expect(catalogToken(w.settings)).toBeUndefined();
    expect(await runLogin(['--with-token'], w.io('   '))).toBe(1);
  });
});
