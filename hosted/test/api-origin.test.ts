// The origin guard, hosted only (the AWS build brief; contract §1.1): the API's own URL stays public, so the edge sends a
// secret header and the handler refuses a request without it, 403 before anything else (then the acting-as header's
// 400, then the token's 401). The current and the previous value both pass (a rotation); an older one doesn't. The
// compare is constant-time with no length leak, the 403's body names no guard, and the value is never logged. The
// values are read once when the guard is made (a cold start) and again after five minutes.

import { Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { createHostedHandler, type HostedRequest } from '../src/api/handler.ts';
import { ORIGIN_HEADER, ORIGIN_KEEP_MS, ORIGIN_MIN_LENGTH, ORIGIN_RETRY_MS, ORIGIN_VALUES_MS, originGuard } from '../src/api/origin.ts';
import type { TokenHolder } from '../src/index.ts';

const CURRENT = 'c'.repeat(43);
const PREVIOUS = 'p'.repeat(43);

function parameters(values: Record<string, string | undefined>) {
  const reads: string[] = [];
  let t = 0;
  return {
    reads,
    clock: { now: () => new Date(t), advance: (ms: number) => void (t += ms) },
    read: async (name: string) => (reads.push(name), values[name]),
  };
}

const NAMES = { current: '/sc/origin', previous: '/sc/origin-previous' };

describe('the origin guard', () => {
  it('the current and the previous value pass; an older one, none, an empty one, or one off by length do not', async () => {
    const p = parameters({ [NAMES.current]: CURRENT, [NAMES.previous]: PREVIOUS });
    const g = originGuard({ names: NAMES, read: p.read, clock: p.clock });
    expect(await g.allows(CURRENT)).toBe(true);
    expect(await g.allows(PREVIOUS)).toBe(true);
    for (const v of [undefined, '', 'o'.repeat(43), CURRENT.slice(1), `${CURRENT}c`, CURRENT.toUpperCase(), ` ${CURRENT}`]) expect(await g.allows(v), String(v)).toBe(false);
  });

  it('no values at all (neither parameter set, or both empty) refuses everything', async () => {
    for (const values of [{}, { [NAMES.current]: '', [NAMES.previous]: '' }]) {
      const p = parameters(values);
      const g = originGuard({ names: NAMES, read: p.read, clock: p.clock });
      for (const v of ['', undefined, CURRENT, 'x']) expect(await g.allows(v), String(v)).toBe(false);
    }
  });

  it(`a value under ${ORIGIN_MIN_LENGTH} characters (a blank or a stand-in) is no value`, async () => {
    expect(ORIGIN_MIN_LENGTH).toBe(32);
    for (const short of [' '.repeat(40).trim() || ' ', 'short', 's'.repeat(31)]) {
      const p = parameters({ [NAMES.current]: short, [NAMES.previous]: PREVIOUS });
      const g = originGuard({ names: NAMES, read: p.read, clock: p.clock });
      expect(await g.allows(short), JSON.stringify(short)).toBe(false);
      expect(await g.allows(PREVIOUS)).toBe(true);
    }
  });

  it('a previous value that is not set yet (the first deploy) leaves only the current one', async () => {
    const p = parameters({ [NAMES.current]: CURRENT });
    const g = originGuard({ names: NAMES, read: p.read, clock: p.clock });
    expect(await g.allows(CURRENT)).toBe(true);
    expect(await g.allows('')).toBe(false);
    expect(await g.allows(undefined)).toBe(false);
  });

  it('the values are read when the guard is made, kept five minutes, then read again in the background (a rotation lands once that read is back)', async () => {
    const values: Record<string, string | undefined> = { [NAMES.current]: CURRENT, [NAMES.previous]: PREVIOUS };
    const p = parameters(values);
    const g = originGuard({ names: NAMES, read: p.read, clock: p.clock });
    expect(p.reads.sort()).toEqual([NAMES.current, NAMES.previous].sort());
    for (let i = 0; i < 5; i++) await g.allows(CURRENT);
    expect(p.reads.length).toBe(2);
    expect(ORIGIN_VALUES_MS).toBe(5 * 60_000);
    values[NAMES.previous] = CURRENT;
    values[NAMES.current] = 'n'.repeat(43);
    p.clock.advance(ORIGIN_VALUES_MS - 1);
    expect(await g.allows(PREVIOUS)).toBe(true);
    p.clock.advance(1);
    // This request starts the read and is answered with the values in hand; the next ones see the rotation.
    expect(await g.allows(PREVIOUS)).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(await g.allows(PREVIOUS)).toBe(false);
    expect(await g.allows('n'.repeat(43))).toBe(true);
    expect(await g.allows(CURRENT)).toBe(true);
    expect(p.reads.length).toBe(4);
  });

  it('a cold start whose read fails refuses; a burst meanwhile costs no read; it reads again after a back-off that doubles; only the error\'s name is logged', async () => {
    let fail = true;
    let t = 0;
    let attempts = 0;
    const logged: string[] = [];
    const g = originGuard({
      names: NAMES,
      read: async (n) => {
        if (n === NAMES.current) attempts++;
        if (fail) throw Object.assign(new Error(`denied reading ${CURRENT}`), { name: 'AccessDeniedException' });
        return n === NAMES.current ? CURRENT : undefined;
      },
      clock: { now: () => new Date(t) },
      log: (l) => logged.push(l),
    });
    expect(await Promise.all([g.allows(CURRENT), g.allows(CURRENT), g.allows(CURRENT)])).toEqual([false, false, false]);
    expect(attempts).toBe(1);
    t = ORIGIN_RETRY_MS - 1;
    expect(await g.allows(CURRENT)).toBe(false);
    expect(attempts).toBe(1);
    t = ORIGIN_RETRY_MS;
    expect(await g.allows(CURRENT)).toBe(false);
    expect(attempts).toBe(2);
    t += ORIGIN_RETRY_MS; // the wait has doubled
    expect(await g.allows(CURRENT)).toBe(false);
    expect(attempts).toBe(2);
    t += ORIGIN_RETRY_MS;
    fail = false;
    expect(await g.allows(CURRENT)).toBe(true);
    expect(attempts).toBe(3);
    expect(logged).toEqual(['origin values: read failed (AccessDeniedException)', 'origin values: read failed (AccessDeniedException)']);
    expect(logged.join('\n')).not.toContain(CURRENT);
  });

  it('a refresh that fails keeps the last good values for up to an hour (a blip in reading them never takes the API down), then refuses', async () => {
    let fail = false;
    let t = 0;
    const g = originGuard({
      names: NAMES,
      read: async (n) => {
        if (fail) throw new Error('ThrottlingException');
        return n === NAMES.current ? CURRENT : PREVIOUS;
      },
      clock: { now: () => new Date(t) },
    });
    expect(await g.allows(CURRENT)).toBe(true);
    fail = true;
    t = ORIGIN_VALUES_MS;
    expect(await g.allows(CURRENT)).toBe(true);
    expect(await g.allows(PREVIOUS)).toBe(true);
    expect(await g.allows('o'.repeat(43))).toBe(false);
    t = ORIGIN_KEEP_MS - 1;
    expect(await g.allows(CURRENT)).toBe(true);
    t = ORIGIN_KEEP_MS;
    expect(await g.allows(CURRENT)).toBe(false);
    fail = false;
    t += ORIGIN_VALUES_MS; // past any back-off
    expect(await g.allows(CURRENT)).toBe(true);
    expect(ORIGIN_KEEP_MS).toBe(60 * 60_000);
  });

  it('the cap: one good read, then every read fails from minute 0; the current value passes at 59 minutes and is refused at 61', async () => {
    let t = 0;
    let fail = false;
    const g = originGuard({
      names: NAMES,
      read: async (n) => {
        if (fail) throw Object.assign(new Error('x'), { name: 'AccessDeniedException' });
        return n === NAMES.current ? CURRENT : undefined;
      },
      clock: { now: () => new Date(t) },
    });
    expect(await g.allows(CURRENT)).toBe(true);
    fail = true;
    for (let m = 1; m <= 59; m++) {
      t = m * 60_000;
      expect(await g.allows(CURRENT), `${m} min`).toBe(true);
    }
    t = 61 * 60_000;
    expect(await g.allows(CURRENT)).toBe(false);
  });

  // A container idle through a rotation holds {old, older} while CloudFront already sends the new value.
  function rotated() {
    const OLD = 'o'.repeat(43);
    const OLDER = 'r'.repeat(43);
    const NEW = 'n'.repeat(43);
    const values: Record<string, string> = { [NAMES.current]: OLD, [NAMES.previous]: OLDER };
    let t = 0;
    let fail = false;
    let attempts = 0;
    const g = originGuard({
      names: NAMES,
      read: async (n) => {
        if (n === NAMES.current) attempts++;
        if (fail) throw Object.assign(new Error('x'), { name: 'ThrottlingException' });
        return values[n];
      },
      clock: { now: () => new Date(t) },
    });
    return {
      g,
      OLD,
      NEW,
      rotate: () => Object.assign(values, { [NAMES.current]: NEW, [NAMES.previous]: OLD }),
      at: (ms: number) => void (t = ms),
      failing: (f: boolean) => void (fail = f),
      attempts: () => attempts,
    };
  }

  it('a value that matches nothing while the values in hand are stale gets one fresh read before the 403: an idle container passes the new value at once', async () => {
    const r = rotated();
    expect(await r.g.allows(r.OLD)).toBe(true);
    r.rotate();
    r.at(ORIGIN_VALUES_MS + 60_000);
    expect(await r.g.allows(r.NEW)).toBe(true);
    expect(r.attempts()).toBe(2);
  });

  it('a burst of wrong values against stale values costs exactly one read; against fresh values, none', async () => {
    const r = rotated();
    expect(await r.g.allows(r.OLD)).toBe(true);
    for (let i = 0; i < 5; i++) expect(await r.g.allows(`w${i}`.repeat(20))).toBe(false);
    expect(r.attempts()).toBe(1);
    r.at(ORIGIN_VALUES_MS);
    expect(await Promise.all(Array.from({ length: 5 }, (_, i) => r.g.allows(`w${i}`.repeat(20))))).toEqual([false, false, false, false, false]);
    expect(await r.g.allows(`z`.repeat(40))).toBe(false);
    expect(r.attempts()).toBe(2);
  });

  it('while backing off after a failed read, a wrong value forces no read either: refused, and the old values still stand', async () => {
    const r = rotated();
    expect(await r.g.allows(r.OLD)).toBe(true);
    r.failing(true);
    r.at(ORIGIN_VALUES_MS);
    expect(await r.g.allows(r.NEW)).toBe(false); // the forced read fails: refused
    expect(r.attempts()).toBe(2);
    for (let i = 0; i < 5; i++) expect(await r.g.allows(`w${i}`.repeat(20))).toBe(false);
    expect(r.attempts()).toBe(2);
    expect(await r.g.allows(r.OLD)).toBe(true);
    expect(r.attempts()).toBe(2);
  });

  it('with good values in hand, a slow refresh never delays a request: it reads in the background and the answer uses what it has', async () => {
    let t = 0;
    let slow = false;
    const release: (() => void)[] = [];
    const g = originGuard({
      names: NAMES,
      read: async (n) => {
        if (slow) await new Promise<void>((r) => release.push(r));
        return n === NAMES.current ? CURRENT : PREVIOUS;
      },
      clock: { now: () => new Date(t) },
    });
    expect(await g.allows(CURRENT)).toBe(true);
    slow = true;
    t = ORIGIN_VALUES_MS;
    const answer = await Promise.race([g.allows(CURRENT), new Promise((r) => setTimeout(() => r('waited'), 50))]);
    expect(answer).toBe(true);
    expect(release.length).toBe(2); // the refresh is under way
    for (const r of release) r();
  });

  it('requests that arrive while the values are being read share that one read (no read ever undoes another)', async () => {
    let t = 0;
    const p = parameters({ [NAMES.current]: CURRENT, [NAMES.previous]: PREVIOUS });
    const g = originGuard({ names: NAMES, read: p.read, clock: { now: () => new Date(t) } });
    expect(await Promise.all([g.allows(CURRENT), g.allows(PREVIOUS), g.allows('x')])).toEqual([true, true, false]);
    expect(p.reads.length).toBe(2);
    t = ORIGIN_VALUES_MS;
    expect(await Promise.all([g.allows(CURRENT), g.allows(CURRENT), g.allows(PREVIOUS)])).toEqual([true, true, true]);
    expect(p.reads.length).toBe(4);
  });
});

// ---------- the handler: the origin first ----------

const words = Words.load();
const HOLDERS: Record<string, TokenHolder> = { 't-dev1': { owner: 'dev1', scope: 'publish', kind: 'personal' } };

function handler() {
  const touched: string[] = [];
  const looked: string[] = [];
  const logged: string[] = [];
  const p = parameters({ [NAMES.current]: CURRENT, [NAMES.previous]: PREVIOUS });
  const h = createHostedHandler({
    catalog: new Proxy({}, { get: (_, k) => (touched.push(String(k)), () => Promise.reject(new Error('touched'))) }) as never,
    tokens: { verify: async (t) => (looked.push(t), HOLDERS[t]) },
    words,
    file: async (s) => (touched.push(`file ${s}`), { kind: 'unknown' }),
    origin: originGuard({ names: NAMES, read: p.read, clock: p.clock }),
    log: (l) => logged.push(l),
  });
  return { h, touched, looked, logged };
}

const req = (path: string, headers: Record<string, string | undefined>, body = '{"query":"x"}'): HostedRequest => ({ method: 'POST', path, headers, body: new TextEncoder().encode(body) });

describe('the handler checks the origin first', () => {
  it('without the origin value: 403 before the acting-as header, the token, the route or the body, the same fixed answer for a wrong or missing value', async () => {
    const w = handler();
    const answers: string[] = [];
    const bodies: string[] = [];
    for (const [path, headers] of [
      ['/api/v1/search_shared_skills', { authorization: 'Bearer t-dev1' }],
      ['/api/v1/search_shared_skills', { authorization: 'Bearer t-dev1', [ORIGIN_HEADER]: 'wrong' }],
      ['/api/v1/search_shared_skills', { 'x-skills-catalog-as': 'bo', [ORIGIN_HEADER]: `${CURRENT}x` }],
      ['/api/v1/no_such_operation', {}],
      ['/not-the-api', {}],
      [`/api/v1/files/${'a'.repeat(64)}`, { authorization: 'Bearer t-dev1' }],
    ] as const) {
      const r = await w.h.handle(req(path, headers));
      expect(r.status, path).toBe(403);
      answers.push(JSON.stringify(r));
      bodies.push(String(r.body));
    }
    expect(new Set(answers).size).toBe(1);
    expect(bodies[0]!.toLowerCase()).not.toMatch(/origin|secret|header|guard/);
    expect(w.looked).toEqual([]);
    expect(w.touched).toEqual([]);
    expect(w.logged).toEqual([]);
  });

  it('with the origin value (current or previous): then the acting-as header (400), then the token (401)', async () => {
    const w = handler();
    for (const v of [CURRENT, PREVIOUS]) {
      expect((await w.h.handle(req('/api/v1/search_shared_skills', { [ORIGIN_HEADER]: v, 'x-skills-catalog-as': 'bo' }))).status).toBe(400);
      expect((await w.h.handle(req('/api/v1/search_shared_skills', { [ORIGIN_HEADER]: v }))).status).toBe(401);
    }
    expect(w.looked).toEqual([]);
  });

  it('the origin value is never in the log, even when a bug is logged', async () => {
    const w = handler();
    const r = await w.h.handle(req('/api/v1/search_shared_skills', { authorization: 'Bearer t-dev1', [ORIGIN_HEADER]: CURRENT }));
    expect(JSON.parse(String(r.body))).toMatchObject({ ok: false, error: { code: 'internal_error' } });
    expect(w.logged.length).toBe(1);
    expect(w.logged.join('\n')).not.toContain(CURRENT);
  });

  it('the guards come before the body: with a body that is not JSON, the acting-as header is still 400 token_only and no token still 401', async () => {
    const w = handler();
    const bad = (headers: Record<string, string>) => w.h.handle(req('/api/v1/search_shared_skills', { [ORIGIN_HEADER]: CURRENT, ...headers }, '{not json'));
    const actingAs = await bad({ authorization: 'Bearer t-dev1', 'x-skills-catalog-as': 'bo' });
    expect(actingAs.status).toBe(400);
    expect(JSON.parse(String(actingAs.body))).toMatchObject({ ok: false, error: { code: 'invalid_request', why: 'token_only' } });
    const none = await bad({});
    expect(none.status).toBe(401);
    expect(JSON.parse(String(none.body))).toMatchObject({ ok: false, error: { code: 'unauthenticated' } });
    expect([w.looked, w.touched]).toEqual([[], []]);
  });

  it('the files route has the same guards: the acting-as header is 400 and no token 401, nothing looked up or read', async () => {
    const w = handler();
    const get = (headers: Record<string, string>) => w.h.handle({ method: 'GET', path: `/api/v1/files/${'a'.repeat(64)}`, headers: { [ORIGIN_HEADER]: CURRENT, ...headers }, body: new Uint8Array() });
    expect((await get({ authorization: 'Bearer t-dev1', 'x-skills-catalog-as': 'bo' })).status).toBe(400);
    expect((await get({ 'x-skills-catalog-as': 'bo' })).status).toBe(400);
    expect((await get({})).status).toBe(401);
    expect([w.looked, w.touched]).toEqual([[], []]);
  });
});
