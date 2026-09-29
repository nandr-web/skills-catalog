// Who's asking, hosted (contract §1.1): identity comes only from `Authorization: Bearer <token>`, a sign-in session or a
// personal token. Refused before anything is looked up: no token, one that isn't a single Bearer credential, and the
// local acting-as header (hosted, nobody chooses who they act as). A token the store doesn't know (unknown, revoked or
// expired) is refused too. A read-scope token reads; changing the catalog takes a publish-scope token.

import { CatalogError } from '@skills-catalog/core';
import type { TokenHolder } from '../tokens.ts';

export type Asking =
  | { kind: 'holder'; holder: TokenHolder }
  | { kind: 'refused'; status: 400 | 401; headers?: Record<string, string> };

const BEARER = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i;
const unauthorized: Asking = { kind: 'refused', status: 401, headers: { 'www-authenticate': 'Bearer' } };

/** Headers by lower-case name, as the transport gives them. */
export async function whoIsAsking(
  headers: Record<string, string | undefined>,
  tokens: { verify(token: string): Promise<TokenHolder | undefined> },
): Promise<Asking> {
  if (headers['x-skills-catalog-as'] !== undefined) return { kind: 'refused', status: 400 };
  const m = BEARER.exec(headers['authorization'] ?? '');
  if (!m) return unauthorized;
  const holder = await tokens.verify(m[1]!);
  return holder ? { kind: 'holder', holder } : unauthorized;
}

/** Whether this holder may run an operation that reads, or one that changes the catalog; undefined when it may. */
export function mayRun(holder: TokenHolder, effect: 'read' | 'publish'): CatalogError | undefined {
  return effect === 'publish' && holder.scope !== 'publish' ? new CatalogError('forbidden', {}) : undefined;
}
