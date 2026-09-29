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
/** How long the last good values still stand while reading them again fails (a blip never takes the API down). */
export const ORIGIN_KEEP_MS = 60 * 60_000;

export type OriginGuard = { allows(sent: string | undefined): Promise<boolean> };

const digest = (v: string) => createHash('sha256').update(v).digest();

/** A guard on the two parameters' values, read now (a cold start) and again once they're ORIGIN_VALUES_MS old; requests
 *  meanwhile share the one read. An unset or empty parameter is no value. Until a read has succeeded, or once the last
 *  good values are ORIGIN_KEEP_MS old and reading still fails, every request is refused. */
export function originGuard(p: { names: { current: string; previous: string }; read: (name: string) => Promise<string | undefined>; clock: Clock }): OriginGuard {
  let good: { digests: Buffer[]; at: number } | undefined;
  let reading: Promise<void> | undefined;
  const read = () =>
    (reading ??= (async () => {
      const at = p.clock.now().getTime();
      try {
        const vs = await Promise.all([p.names.current, p.names.previous].map(p.read));
        good = { digests: vs.filter((v): v is string => typeof v === 'string' && v !== '').map(digest), at };
      } finally {
        reading = undefined;
      }
    })());
  read().catch(() => {});
  return {
    async allows(sent) {
      if (!good || p.clock.now().getTime() - good.at >= ORIGIN_VALUES_MS) {
        try {
          await read();
        } catch {
          // The last good values stand, within ORIGIN_KEEP_MS.
        }
      }
      if (!good || p.clock.now().getTime() - good.at >= ORIGIN_KEEP_MS) return false;
      if (sent === undefined || sent === '') return false;
      const d = digest(sent);
      // Every value is compared, whichever matches.
      let ok = false;
      for (const k of good.digests) ok = timingSafeEqual(d, k) || ok;
      return ok;
    },
  };
}
