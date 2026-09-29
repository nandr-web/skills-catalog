// The hosted API on Lambda (an HTTP API's payload format 2.0): the adapter only moves bytes. The request's method, raw
// path, headers by lower-case name and body (base64 or text, cut past the core's body limit) go to the handler; its
// answer comes back with binary bodies base64 encoded.

import { BODY_LIMIT, type HttpResponse } from '@skills-catalog/core/http';
import { describe, expect, it } from 'vitest';
import type { HostedRequest } from '../src/api/handler.ts';
import { lambdaAdapter, type HttpApiEvent } from '../src/api/lambda.ts';

const event = (e: Partial<HttpApiEvent> & { method?: string }): HttpApiEvent => ({
  rawPath: '/api/v1/search_shared_skills',
  headers: { 'content-type': 'application/json' },
  requestContext: { http: { method: e.method ?? 'POST' } },
  ...e,
});

function capture(answer: HttpResponse = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' }) {
  const seen: HostedRequest[] = [];
  const handle = lambdaAdapter({ handle: async (r) => (seen.push(r), answer) });
  return { seen, handle };
}

describe('the Lambda adapter', () => {
  it('passes the method, the raw path (never a decoded one), the headers by lower-case name and a text body', async () => {
    const { seen, handle } = capture();
    const r = await handle(event({ rawPath: '/api/v1/files/%2e%2e', headers: { Authorization: 'Bearer t', 'X-Skills-Catalog-As': 'bo' }, body: '{"query":"x"}' }));
    expect(seen[0]!.method).toBe('POST');
    expect(seen[0]!.path).toBe('/api/v1/files/%2e%2e');
    expect(seen[0]!.headers).toEqual({ authorization: 'Bearer t', 'x-skills-catalog-as': 'bo' });
    expect(new TextDecoder().decode(seen[0]!.body as Uint8Array)).toBe('{"query":"x"}');
    expect(r).toEqual({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}', isBase64Encoded: false });
  });

  it('a base64 body is decoded; no body is empty', async () => {
    const { seen, handle } = capture();
    await handle(event({ body: Buffer.from('{"a":1}').toString('base64'), isBase64Encoded: true }));
    await handle(event({ method: 'GET', rawPath: '/api/v1/files/x' }));
    expect(new TextDecoder().decode(seen[0]!.body as Uint8Array)).toBe('{"a":1}');
    expect((seen[1]!.body as Uint8Array).length).toBe(0);
  });

  it('a body past the core\'s limit is cut, never passed whole', async () => {
    const { seen, handle } = capture();
    await handle(event({ body: Buffer.alloc(BODY_LIMIT + 1, 97).toString('base64'), isBase64Encoded: true }));
    await handle(event({ body: 'a'.repeat(BODY_LIMIT + 1) }));
    await handle(event({ body: 'a'.repeat(BODY_LIMIT) }));
    expect(seen.map((r) => (r.body === 'cut' ? 'cut' : r.body.length))).toEqual(['cut', 'cut', BODY_LIMIT]);
  });

  it('a binary answer goes back base64 encoded', async () => {
    const { handle } = capture({ status: 200, headers: { 'content-type': 'application/octet-stream' }, body: new TextEncoder().encode('bytes') });
    const r = await handle(event({ method: 'GET', rawPath: '/api/v1/files/x' }));
    expect(r).toMatchObject({ statusCode: 200, isBase64Encoded: true, body: Buffer.from('bytes').toString('base64') });
  });
});
