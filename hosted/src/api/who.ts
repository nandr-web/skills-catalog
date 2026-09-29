// Who's asking, hosted (contract §1.1, §9): identity comes only from `Authorization: Bearer <token>`, a sign-in session
// or a personal token. Refused before anything is looked up: the local acting-as header (hosted, nobody chooses who they
// act as: invalid_request token_only, 400), then no token or one that isn't a single Bearer credential (unauthenticated,
// 401). A token the store doesn't know (unknown, revoked or expired) is unauthenticated too. A read-scope token reads;
// an operation whose row changes the catalog takes a publish-scope token (else forbidden read_scope, the operation's
// answer in the envelope).

import { CatalogError } from '@skills-catalog/core';
import { effectOf } from '@skills-catalog/core/http';
import type { TokenHolder } from '../tokens.ts';

export type Asking =
  | { kind: 'holder'; holder: TokenHolder }
  // An operation called with no token (signing in, which is how one is got): nobody acts.
  | { kind: 'nobody' }
  | { kind: 'refused'; status: 400 | 401; error: CatalogError };

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;
// The 401's Bearer challenge is the transport's refusal (core/http), not part of who's asking.
const unauthenticated = (): Asking => ({ kind: 'refused', status: 401, error: new CatalogError('unauthenticated', {}) });

/** Headers by lower-case name, as the transport gives them. `tokenless`: the operation's row takes no token, so none
 *  is looked up, even one sent along; the acting-as header is still refused. */
export async function whoIsAsking(
  headers: Record<string, string | undefined>,
  tokens: { verify(token: string): Promise<TokenHolder | undefined> },
  tokenless = false,
): Promise<Asking> {
  if (headers['x-skills-catalog-as'] !== undefined) {
    return { kind: 'refused', status: 400, error: new CatalogError('invalid_request', { field: 'X-Skills-Catalog-As', why: 'token_only' }) };
  }
  if (tokenless) return { kind: 'nobody' };
  const m = BEARER.exec(headers['authorization'] ?? '');
  if (!m) return unauthenticated();
  const holder = await tokens.verify(m[1]!);
  return holder ? { kind: 'holder', holder } : unauthenticated();
}

/** Whether this holder may run the operation, by its row's effect; undefined when it may. An operation a hosted
 *  catalog's web face doesn't serve never gets here (the route refuses it): a bug, thrown. */
export function mayRun(holder: TokenHolder, operation: string): CatalogError | undefined {
  const effect = effectOf(operation, 'hosted');
  if (effect === undefined) throw new Error(`no hosted web operation ${JSON.stringify(operation)}`);
  if (effect === 'reads') return undefined;
  return holder.scope === 'publish' ? undefined : new CatalogError('forbidden', { why: 'read_scope' });
}
