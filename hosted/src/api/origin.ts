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
/** How long the last good values still stand while reading them again fails (a blip never takes the API down; a read
 *  lost for good surfaces, and a value retired by rotation stops working, within this). */
export const ORIGIN_KEEP_MS = 60 * 60_000;
/** After a failed read, the next waits this long, doubling with each failure up to ORIGIN_VALUES_MS. */
export const ORIGIN_RETRY_MS = 1000;
/** A value shorter than this (a blank, a stand-in) is no value. */
export const ORIGIN_MIN_LENGTH = 32;

export type OriginGuard = { allows(sent: string | undefined): Promise<boolean> };

const digest = (v: string) => createHash('sha256').update(v).digest();

/** A guard on the two parameters' values (contract §1.1), read now (a cold start) and again, in the background, once
 *  they're ORIGIN_VALUES_MS old; requests meanwhile share the one read and answer with the values in hand. A value that
 *  matches nothing while those are stale forces one shared read before the 403, so a container idle through a rotation
 *  passes the new value. A failed read is retried only after a back-off, and logs only its error's name. Until a read
 *  has succeeded, or once the last good values are ORIGIN_KEEP_MS old, every request is refused. */
export function originGuard(p: {
  names: { current: string; previous: string };
  read: (name: string) => Promise<string | undefined>;
  clock: Clock;
  log?: (line: string) => void;
}): OriginGuard {
  const log = p.log ?? ((line: string) => console.error(line));
  const now = () => p.clock.now().getTime();
  let good: { digests: Buffer[]; at: number } | undefined;
  let reading: Promise<void> | undefined;
  let failures = 0;
  let retryAt = 0;
  const read = () =>
    (reading ??= (async () => {
      const at = now();
      try {
        const vs = await Promise.all([p.names.current, p.names.previous].map(p.read));
        good = { digests: vs.filter((v): v is string => typeof v === 'string' && v.length >= ORIGIN_MIN_LENGTH).map(digest), at };
        failures = 0;
      } catch (e) {
        failures++;
        retryAt = now() + Math.min(ORIGIN_RETRY_MS * 2 ** (failures - 1), ORIGIN_VALUES_MS);
        log(`origin values: read failed (${e instanceof Error ? e.name : typeof e})`);
        throw e;
      } finally {
        // On Lambda a read can be frozen between invocations and resume on the next; it's cleared only when it
        // settles, so requests keep sharing it rather than starting another.
        reading = undefined;
      }
    })());
  // A read in flight is free to share; a new one waits out the back-off.
  const mayRead = () => reading !== undefined || now() >= retryAt;
  const usable = () => good !== undefined && now() - good.at < ORIGIN_KEEP_MS;
  const matches = (d: Buffer) => {
    // Every value is compared, whichever matches.
    let ok = false;
    for (const k of good!.digests) ok = timingSafeEqual(d, k) || ok;
    return ok;
  };
  read().catch(() => {});
  return {
    async allows(sent) {
      if (!usable()) {
        // Nothing good in hand: this request waits for a read, if one may be made.
        if (mayRead()) await read().catch(() => {});
      } else if (now() - good!.at >= ORIGIN_VALUES_MS && mayRead()) {
        // Good values in hand: read again in the background and answer with them; a failed read leaves them standing.
        read().catch(() => {});
      }
      if (!usable() || sent === undefined || sent === '') return false;
      const d = digest(sent);
      if (matches(d)) return true;
      // A miss against stale values: one shared read, then compare again; a failed read refuses.
      if (now() - good!.at < ORIGIN_VALUES_MS || !mayRead()) return false;
      await read().catch(() => {});
      return usable() && now() - good!.at < ORIGIN_VALUES_MS && matches(d);
    },
  };
}
