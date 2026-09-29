// The hosted API on Lambda, behind an HTTP API (payload format 2.0): this only moves bytes. In: the method, the raw path
// (never a decoded one), the headers by lower-case name, and the body, base64 or text, cut past the core's body limit so
// no more is ever held. Out: the handler's answer, a binary body base64 encoded. Every rule is the handler's.

import { BODY_LIMIT, type HttpResponse } from '@skills-catalog/core/http';
import type { HostedRequest } from './handler.ts';

/** The parts of an HTTP API event (payload 2.0) the adapter reads. */
export type HttpApiEvent = {
  rawPath: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
};
export type HttpApiResult = { statusCode: number; headers: Record<string, string>; body: string; isBase64Encoded: boolean };

function bodyOf(e: HttpApiEvent): Uint8Array | 'cut' {
  if (e.body === undefined || e.body === '') return new Uint8Array();
  if (e.isBase64Encoded) {
    // Base64 is 4 characters per 3 bytes: a string that decodes to more than the limit is cut before it's decoded.
    if (Math.floor((e.body.length * 3) / 4) - (e.body.endsWith('==') ? 2 : e.body.endsWith('=') ? 1 : 0) > BODY_LIMIT) return 'cut';
    return new Uint8Array(Buffer.from(e.body, 'base64'));
  }
  // A text body's bytes are at least its length in characters.
  if (e.body.length > BODY_LIMIT) return 'cut';
  const bytes = new TextEncoder().encode(e.body);
  return bytes.length > BODY_LIMIT ? 'cut' : bytes;
}

export function lambdaAdapter(handler: { handle(req: HostedRequest): Promise<HttpResponse> }): (e: HttpApiEvent) => Promise<HttpApiResult> {
  return async (e) => {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(e.headers ?? {})) headers[k.toLowerCase()] = v;
    const r = await handler.handle({ method: e.requestContext.http.method, path: e.rawPath, headers, body: bodyOf(e) });
    const binary = typeof r.body !== 'string';
    return { statusCode: r.status, headers: r.headers, body: binary ? Buffer.from(r.body).toString('base64') : (r.body as string), isBase64Encoded: binary };
  };
}
