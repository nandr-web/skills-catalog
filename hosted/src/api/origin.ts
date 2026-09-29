// The origin guard, hosted only (contract §1.1): the API's own URL stays public, so the edge sends a secret header on
// every request it forwards (its value from a parameter the deploy rotates) and the handler refuses a request without
// it before anything else. The current and the previous value both pass, so a rotation drops nothing. Each side is
// hashed before a constant-time compare, so neither the value nor its length leaks by timing. The value is never logged.

import { createHash, timingSafeEqual } from 'node:crypto';
import type { Clock } from '@skills-catalog/core';

/** The header the edge sends (CloudFront's origin custom header, which overwrites one a viewer sends). */
export const ORIGIN_HEADER = 'x-skills-catalog-origin';
/** How long read values are kept before they're read again (a rotation lands within this). */
export const ORIGIN_VALUES_MS = 5 * 60_000;

export type OriginGuard = { allows(sent: string | undefined): Promise<boolean> };

const digest = (v: string) => createHash('sha256').update(v).digest();

/** A guard on the two parameters' values, read now (a cold start) and again once they're ORIGIN_VALUES_MS old. An unset
 *  or empty parameter is no value; with none, or while a read fails, every request is refused. */
export function originGuard(p: { names: { current: string; previous: string }; read: (name: string) => Promise<string | undefined>; clock: Clock }): OriginGuard {
  let values: Promise<Buffer[]> | undefined;
  let readAt = 0;
  const load = () => {
    readAt = p.clock.now().getTime();
    values = Promise.all([p.names.current, p.names.previous].map(p.read)).then((vs) => vs.filter((v): v is string => typeof v === 'string' && v !== '').map(digest));
    // A failed read isn't kept: the next request reads again.
    values.catch(() => (values = undefined));
    return values;
  };
  load();
  return {
    async allows(sent) {
      if (!values || p.clock.now().getTime() - readAt >= ORIGIN_VALUES_MS) load();
      let known: Buffer[];
      try {
        known = await values!;
      } catch {
        return false;
      }
      if (sent === undefined || sent === '') return false;
      const d = digest(sent);
      // Every value is compared, whichever matches.
      let ok = false;
      for (const k of known) ok = timingSafeEqual(d, k) || ok;
      return ok;
    },
  };
}
