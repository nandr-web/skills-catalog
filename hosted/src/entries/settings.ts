// Each function's settings, from its environment (set by the stack): where the catalog keeps things, and for the API the
// names of its parameters (their values are read at run time, never put in the environment), the GitHub app's client id
// and the sign-in list. A missing or blank setting fails the function at start, naming the setting, never a value.

import type { Place } from '../place.ts';

type Env = Record<string, string | undefined>;

export type ApiSettings = {
  place: Place;
  /** The origin header's parameters: the value in use and the one before it (rotation). */
  origin: { current: string; previous: string };
  github: { clientId: string; secretParameter: string };
  /** The GitHub logins that may sign in; empty is nobody. */
  signInLogins: string[];
};

function setting(env: Env, name: string): string {
  const v = env[name]?.trim();
  if (!v) throw new Error(`the function's setting ${name} is missing`);
  return v;
}

const placeOf = (env: Env): Place => ({ table: setting(env, 'CATALOG_TABLE'), bucket: setting(env, 'CATALOG_BUCKET') });

export function apiSettings(env: Env): ApiSettings {
  // The sign-in list must be set, even to nothing, so leaving it out is a mistake that shows rather than nobody.
  const logins = env['SIGN_IN_LOGINS'];
  if (logins === undefined) throw new Error("the function's setting SIGN_IN_LOGINS is missing");
  return {
    place: placeOf(env),
    origin: { current: setting(env, 'ORIGIN_SECRET_PARAMETER'), previous: setting(env, 'ORIGIN_SECRET_PREVIOUS_PARAMETER') },
    github: { clientId: setting(env, 'GITHUB_CLIENT_ID'), secretParameter: setting(env, 'GITHUB_SECRET_PARAMETER') },
    signInLogins: logins.split(',').map((l) => l.trim()).filter((l) => l !== ''),
  };
}

export const indexerSettings = (env: Env): { place: Place } => ({ place: placeOf(env) });
export const sweepSettings = (env: Env): { place: Place } => ({ place: placeOf(env) });
