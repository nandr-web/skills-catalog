// skills-catalog login / logout: a hosted catalog's token for this machine (contract §1.1). Login signs in with GitHub's
// device flow (the person opens github.com/login/device and types a code; no secret on this machine), hands GitHub's
// token to the catalog's sign_in_with_github, and saves the catalog's token in $SKILLS_HOME/token (0600, the client's
// own folder, 0700). GitHub's token is never saved. `--with-token` reads a catalog token from stdin instead (a personal
// token). Logout deletes the saved token. The GitHub app's client id comes from --client-id or SKILLS_GITHUB_CLIENT_ID
// (the deploy prints it).

import { constants, fchmodSync, mkdirSync, openSync, closeSync, writeSync, rmSync, lstatSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { tokenFile, type Settings } from '../settings.ts';

export type LoginIo = {
  settings: Settings;
  env: Record<string, string | undefined>;
  stdout: (t: string) => void;
  stderr: (t: string) => void;
  readStdin: () => Promise<string>;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
};

const GITHUB = 'https://github.com';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';

function saveToken(s: Settings, token: string): string {
  mkdirSync(s.home, { recursive: true, mode: 0o700 });
  const file = tokenFile(s);
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, `${token}\n`);
  } finally {
    closeSync(fd);
  }
  return file;
}

async function post(http: typeof fetch, url: string, body: Record<string, unknown>): Promise<any> {
  const r = await http(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${url} answered ${r.status} without JSON`);
  }
}

export async function runLogin(args: string[], io: LoginIo): Promise<number> {
  const http = io.fetch ?? fetch;
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let values: { 'client-id'?: string; scope?: string; 'with-token'?: boolean };
  try {
    ({ values } = parseArgs({ args, options: { 'client-id': { type: 'string' }, scope: { type: 'string' }, 'with-token': { type: 'boolean' } }, strict: true, allowPositionals: false }));
  } catch (e) {
    io.stderr(`${e instanceof Error ? e.message : String(e)}\nUsage: skills-catalog login [--scope publish|read] [--client-id <id>] | --with-token < token\n`);
    return 1;
  }
  const catalog = io.settings.catalog;
  if (!catalog.startsWith('https://')) {
    io.stderr(`skills-catalog login signs in to a hosted catalog; SKILLS_CATALOG is ${catalog}, a local one, which needs no sign-in.\n`);
    return 1;
  }
  if (values['with-token']) {
    const token = (await io.readStdin()).trim();
    if (!/^[\x21-\x7e]{16,512}$/.test(token)) {
      io.stderr('No token on stdin (or not one: printable, no spaces, 16 to 512 characters). Nothing was saved.\n');
      return 1;
    }
    io.stdout(`Saved the token for ${catalog} in ${saveToken(io.settings, token)}.\n`);
    return 0;
  }
  const scope = values.scope ?? 'publish';
  if (scope !== 'publish' && scope !== 'read') {
    io.stderr(`--scope is publish or read, not ${scope}.\n`);
    return 1;
  }
  const clientId = values['client-id'] ?? io.env['SKILLS_GITHUB_CLIENT_ID'];
  if (!clientId) {
    io.stderr("The catalog's GitHub app client id is needed: --client-id <id>, or SKILLS_GITHUB_CLIENT_ID (the deploy prints it).\n");
    return 1;
  }

  const device = await post(http, `${GITHUB}/login/device/code`, { client_id: clientId });
  if (typeof device?.device_code !== 'string' || typeof device?.user_code !== 'string') {
    io.stderr(`GitHub didn't start a sign-in${device?.error ? ` (${device.error})` : ''}. Nothing was saved.\n`);
    return 1;
  }
  io.stdout(`Open ${device.verification_uri ?? `${GITHUB}/login/device`} and enter the code ${device.user_code}\nWaiting for you to approve it on GitHub…\n`);

  let interval = Math.max(1, Number(device.interval) || 5) * 1000;
  const until = Date.now() + (Number(device.expires_in) || 900) * 1000;
  let githubToken: string | undefined;
  while (!githubToken) {
    if (Date.now() > until) {
      io.stderr('The code expired before it was approved. Run skills-catalog login again. Nothing was saved.\n');
      return 1;
    }
    await sleep(interval);
    const r = await post(http, `${GITHUB}/login/oauth/access_token`, { client_id: clientId, device_code: device.device_code, grant_type: DEVICE_GRANT });
    if (typeof r?.access_token === 'string') githubToken = r.access_token;
    else if (r?.error === 'authorization_pending') continue;
    else if (r?.error === 'slow_down') interval += 5000;
    else {
      io.stderr(`GitHub refused the sign-in (${r?.error ?? 'no answer'}). Nothing was saved.\n`);
      return 1;
    }
  }

  const answer = await post(http, `${catalog.replace(/\/+$/, '')}/api/v1/sign_in_with_github`, { github_token: githubToken, scope });
  if (answer?.ok !== true || typeof answer.data?.token !== 'string') {
    io.stderr(`${answer?.words?.error ?? `The catalog refused the sign-in (${answer?.error?.code ?? 'no answer'}).`} Nothing was saved.\n`);
    return 1;
  }
  const file = saveToken(io.settings, answer.data.token);
  io.stdout(`Signed in to ${catalog} (${scope}), until ${answer.data.expires_at}. The token is in ${file}.\n`);
  return 0;
}

export function runLogout(io: Pick<LoginIo, 'settings' | 'stdout'>): number {
  const file = tokenFile(io.settings);
  let there = false;
  try {
    there = lstatSync(file).isFile();
  } catch {
    /* none */
  }
  if (there) rmSync(file);
  io.stdout(there ? `Deleted the saved token (${file}).\n` : 'No saved token; nothing to delete.\n');
  return 0;
}
