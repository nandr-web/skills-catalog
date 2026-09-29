// Signing in with GitHub, hosted (contract §1.1): GitHub's check for tokens issued to our OAuth app, the only call the
// hosted catalog makes outside AWS. POST /applications/{client_id}/token with basic auth (the app's id and secret)
// answers a token of ours with its user; any other app's token, a revoked one or an unknown one is 404 (422 when it
// can't be checked). Never GET /user, which takes a token of any app. The secret comes from a parameter, read and kept
// for five minutes. GitHub unreachable, slow or refusing our own credentials is thrown: the catalog's failure, never
// the person's. No error's message names a token or the secret.

import type { Clock, GitHubSignIn } from '@skills-catalog/core';

/** The one place outbound calls go. */
export const GITHUB_API = 'https://api.github.com';
/** How long GitHub may take to answer. */
export const GITHUB_TIMEOUT_MS = 5000;
/** How long the app's secret is kept before it's read again. */
export const GITHUB_SECRET_MS = 5 * 60_000;

export class HostedGitHubSignIn implements GitHubSignIn {
  private readonly p: { clientId: string; secret: () => Promise<string>; fetch: typeof fetch; clock: Clock; timeoutMs: number };
  private kept: { value: string; at: number } | undefined;

  constructor(parts: { clientId: string; secret: () => Promise<string>; clock: Clock; fetch?: typeof fetch; timeoutMs?: number }) {
    if (!parts.clientId) throw new Error("signing in needs the GitHub app's client id");
    this.p = { fetch: globalThis.fetch, timeoutMs: GITHUB_TIMEOUT_MS, ...parts };
  }

  async login(githubToken: string): Promise<string | undefined> {
    const secret = await this.secret();
    const r = await this.p.fetch(`${GITHUB_API}/applications/${encodeURIComponent(this.p.clientId)}/token`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${this.p.clientId}:${secret}`).toString('base64')}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'skills-catalog',
      },
      body: JSON.stringify({ access_token: githubToken }),
      signal: AbortSignal.timeout(this.p.timeoutMs),
    });
    if (r.status === 404 || r.status === 422) return undefined;
    if (!r.ok) throw new Error(`GitHub's token check answered ${r.status}`);
    const login = ((await r.json()) as { user?: { login?: unknown } }).user?.login;
    if (typeof login !== 'string' || !login) throw new Error("GitHub's token check answered without a login");
    return login;
  }

  private async secret(): Promise<string> {
    const now = this.p.clock.now().getTime();
    if (this.kept && now - this.kept.at < GITHUB_SECRET_MS) return this.kept.value;
    const value = await this.p.secret();
    if (!value) throw new Error("the GitHub app's secret is empty");
    this.kept = { value, at: now };
    return value;
  }
}
