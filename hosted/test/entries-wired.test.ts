// The functions' entries, wired whole on the stand-in: each opens from its environment (the settings the stack gives it)
// with its AWS clients and nothing else. The API answers through its Lambda event with the origin guard's values and
// GitHub's secret read from parameters; the indexer takes the queue's messages (the stream's inserts) and indexes the
// skill and names its files, reporting a failed message so the queue gives it again; the sweep runs its two passes.

import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import { Words, actAs } from '@skills-catalog/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HttpApiEvent } from '../src/api/lambda.ts';
import { openApi, openHostedCatalog, openIndexer, openSweep, type QueueEvent } from '../src/entries/index.ts';
import { createStores, isNamed, namesClient, S3SearchIndex, type Place } from '../src/index.ts';
import { SEARCH_KEY } from '../src/place.ts';
import { toUploaded } from './adapter.ts';
import { FAKE, startEmulator, type Emulator } from './emulator.ts';

let emu: Emulator | undefined;
beforeAll(async () => {
  emu = await startEmulator();
}, 30_000);
afterAll(async () => {
  await emu?.stop();
});

const ORIGIN = 'o'.repeat(40);
const GITHUB = `gho_${'g'.repeat(36)}`;
// The API is given its words; its Lambda handler reads them from beside the bundle, where the stack's build puts them.
const words = Words.load();
let n = 0;

function clients() {
  return {
    ddb: new DynamoDBClient({ ...FAKE, endpoint: emu!.endpoint }),
    s3: new S3Client({ ...FAKE, endpoint: emu!.endpoint, forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }),
  };
}

/** A fresh table and bucket, and the environment the stack gives each function for them. */
async function place() {
  const p: Place = { table: `entries-${++n}`, bucket: `entries-${n}` };
  const c = clients();
  await createStores(c.ddb, c.s3, p);
  const env = {
    CATALOG_TABLE: p.table,
    CATALOG_BUCKET: p.bucket,
    ORIGIN_SECRET_PARAMETER: '/catalog/origin',
    ORIGIN_SECRET_PREVIOUS_PARAMETER: '/catalog/origin-previous',
    GITHUB_SECRET_PARAMETER: '/catalog/github-secret',
    GITHUB_CLIENT_ID: 'Iv1.entries',
    SIGN_IN_LOGINS: 'ana',
  };
  return { place: p, env, ...c };
}

/** Parameter Store's stand-in: the origin value and GitHub's secret; the previous origin value never set. */
const ssm = (values: Record<string, string> = { '/catalog/origin': ORIGIN, '/catalog/github-secret': 's'.repeat(40) }) => ({
  send: async (cmd: unknown) => {
    const name = (cmd as GetParameterCommand).input.Name!;
    if (!(cmd instanceof GetParameterCommand)) throw new Error('only GetParameter');
    if (values[name] === undefined) throw new ParameterNotFound({ message: 'not found', $metadata: {} });
    return { Parameter: { Name: name, Value: values[name] } };
  },
});

/** GitHub's stand-in: our app's token is ana's, id 7. */
const github = (async (_url: string, init: RequestInit) =>
  JSON.parse(String(init.body)).access_token === GITHUB ? new Response(JSON.stringify({ user: { login: 'ana', id: 7 } }), { status: 200 }) : new Response('{}', { status: 404 })) as unknown as typeof fetch;

const event = (op: string, body: unknown, headers: Record<string, string> = {}): HttpApiEvent => ({
  rawPath: `/api/v1/${op}`,
  headers: { 'x-skills-catalog-origin': ORIGIN, 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
  isBase64Encoded: false,
  requestContext: { http: { method: 'POST' } },
});
const answer = (r: { body: string }) => JSON.parse(r.body) as { ok: boolean; data?: any; error?: any };

describe('the API entry', () => {
  it('opens from its environment and answers through its Lambda event: signs in with GitHub, then lists that token', async () => {
    const w = await place();
    const api = await openApi({ env: w.env, ddb: w.ddb, s3: w.s3, ssm: ssm(), words, fetch: github, log: () => {} });
    const signedIn = answer(await api(event('sign_in_with_github', { github_token: GITHUB, scope: 'read' })));
    expect(signedIn.ok).toBe(true);
    const listed = answer(await api(event('list_tokens', {}, { authorization: `Bearer ${signedIn.data.token}` })));
    expect(listed.data.tokens.map((t: { id: string }) => t.id)).toEqual([signedIn.data.id]);
    const search = answer(await api(event('search_shared_skills', { query: 'anything' }, { authorization: `Bearer ${signedIn.data.token}` })));
    expect(search.ok).toBe(true);
  });

  it('refuses a request without the origin value (the previous one never set, as on a first deploy), before anything else', async () => {
    const w = await place();
    const api = await openApi({ env: w.env, ddb: w.ddb, s3: w.s3, ssm: ssm(), words, fetch: github, log: () => {} });
    const r = await api({ ...event('list_tokens', {}), headers: {} });
    expect(r.statusCode).toBe(403);
    const wrong = await api(event('list_tokens', {}, { 'x-skills-catalog-origin': 'x'.repeat(40) }));
    expect(wrong.statusCode).toBe(403);
  });

  it("GitHub's secret parameter unset: a sign-in is the catalog's failure (internal_error), never unauthenticated", async () => {
    const w = await place();
    const logged: string[] = [];
    const api = await openApi({ env: w.env, ddb: w.ddb, s3: w.s3, ssm: ssm({ '/catalog/origin': ORIGIN }), words, fetch: github, log: (l) => void logged.push(l) });
    expect(answer(await api(event('sign_in_with_github', { github_token: GITHUB, scope: 'read' }))).error).toEqual({ code: 'internal_error' });
    expect(logged.join('\n')).not.toContain(GITHUB);
  });

  it('never reads the events itself, opening or publishing (the stream carries them to the indexer)', async () => {
    const w = await place();
    const asked: string[] = [];
    const send = w.ddb.send.bind(w.ddb);
    w.ddb.send = ((cmd: { input?: { ExpressionAttributeValues?: Record<string, { S?: string }> } }, ...rest: unknown[]) => {
      if (cmd instanceof QueryCommand && cmd.input.ExpressionAttributeValues?.[':pk']?.S === 'events') asked.push('events');
      return (send as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as typeof w.ddb.send;
    const api = await openApi({ env: w.env, ddb: w.ddb, s3: w.s3, ssm: ssm(), words, fetch: github, log: () => {} });
    const token = answer(await api(event('sign_in_with_github', { github_token: GITHUB, scope: 'publish' }))).data.token;
    const auth = { authorization: `Bearer ${token}` };
    const md = Buffer.from('---\nname: via-api\ndescription: Published through the entry.\n---\nBody.\n');
    const sha = (await import('node:crypto')).createHash('sha256').update(md).digest('hex');
    const links = answer(await api(event('request_upload_links', { name: 'via-api', files: [{ sha256: sha, size: md.length }] }, auth)));
    const link = links.data.files[0];
    expect((await fetch(link.url, { method: 'PUT', body: md, headers: link.headers })).ok).toBe(true);
    const r = answer(await api(event('publish_version', { name: 'via-api', files: [{ path: 'SKILL.md', mode: '0644', sha256: sha }] }, auth)));
    expect(r.data.version).toBe(1);
    expect(asked).toEqual([]);
    // Found by the next search, before any indexer has run (review F1: the reply's "teammates can find it now").
    const found = answer(await api(event('search_shared_skills', { query: 'published entry' }, auth)));
    expect(found.data.results.map((c: { name: string }) => c.name)).toEqual(['via-api']);
  });

  it('a search file that fails at publish leaves the publish done and logged; the indexer is the backstop', async () => {
    const w = await place();
    const send = w.s3.send.bind(w.s3);
    w.s3.send = ((cmd: unknown, ...rest: unknown[]) => {
      if (cmd instanceof PutObjectCommand && cmd.input.Key === SEARCH_KEY) return Promise.reject(Object.assign(new Error('slow down'), { name: 'SlowDown' }));
      return (send as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as typeof w.s3.send;
    const logged: string[] = [];
    const { catalog } = await openHostedCatalog({ ddb: w.ddb, s3: w.s3, place: w.place, clock: { now: () => new Date() }, signIn: { login: async () => undefined }, signInLogins: [], log: (l) => void logged.push(l) });
    const md = '---\nname: pdf-tools\ndescription: Fill and merge PDF forms.\n---\nBody.\n';
    const identity = actAs('ana');
    const input = await toUploaded(catalog, { name: 'pdf-tools', files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(md).toString('base64') }] }, identity);
    expect(await catalog.publish(input, identity)).toMatchObject({ version: 1, created: true });
    catalog.close();
    expect(logged.join('\n')).toContain('indexing pdf-tools at publish failed');
  });

  it('a missing setting fails the entry at open, naming it', async () => {
    const w = await place();
    const { GITHUB_CLIENT_ID: _, ...env } = w.env;
    await expect(openApi({ env, ddb: w.ddb, s3: w.s3, ssm: ssm(), words, fetch: github, log: () => {} })).rejects.toThrow('GITHUB_CLIENT_ID');
  });
});

/** The queue message the pipe sends for each event item a commit wrote: the stream record's insert, as JSON. */
async function queued(ddb: DynamoDBClient, p: Place): Promise<QueueEvent> {
  const items = (await ddb.send(new QueryCommand({ TableName: p.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: 'events' } } }))).Items ?? [];
  return { Records: items.map((NewImage, i) => ({ messageId: `m${i + 1}`, body: JSON.stringify({ eventID: `e${i + 1}`, eventName: 'INSERT', dynamodb: { Keys: { pk: NewImage['pk'], sk: NewImage['sk'] }, NewImage } }) })) };
}

async function published(w: Awaited<ReturnType<typeof place>>) {
  const { catalog } = await openHostedCatalog({ ddb: w.ddb, s3: w.s3, place: w.place, clock: { now: () => new Date() }, signIn: { login: async () => undefined }, signInLogins: [] });
  const md = '---\nname: pdf-tools\ndescription: Fill and merge PDF forms.\n---\nBody.\n';
  const identity = actAs('ana');
  const input = await toUploaded(catalog, { name: 'pdf-tools', files: [{ path: 'SKILL.md', mode: '0644', content_base64: Buffer.from(md).toString('base64') }] }, identity);
  const r = (await catalog.publish(input, identity)) as { version: number };
  const sha = (input as { files: { sha256: string }[] }).files[0]!.sha256;
  catalog.close();
  return { version: r.version, sha };
}

describe('the indexer entry', () => {
  it("indexes each queued version's skill and names its files; the same message again changes nothing", async () => {
    const w = await place();
    const { sha } = await published(w);
    const search = new S3SearchIndex({ s3: w.s3, place: w.place });
    const indexed = async () => (await search.query([], {})).map((h) => h.card.name);
    // The API indexed it at publish (review F1); empty the search file so the indexer's own work shows.
    expect(await indexed()).toEqual(['pdf-tools']);
    await search.rebuild([]);
    expect(await indexed()).toEqual([]);
    expect(await isNamed(w.ddb, w.place, sha)).toBe(false);
    const indexer = openIndexer({ env: w.env, ddb: w.ddb, s3: w.s3, names: namesClient({ ...FAKE, endpoint: emu!.endpoint }), log: () => {} });
    const q = await queued(w.ddb, w.place);
    expect(q.Records).toHaveLength(1);
    expect(await indexer(q)).toEqual({ batchItemFailures: [] });
    expect(await indexed()).toEqual(['pdf-tools']);
    expect(await isNamed(w.ddb, w.place, sha)).toBe(true);
    expect(await indexer(q)).toEqual({ batchItemFailures: [] });
  });

  it("a names write that fails reports the message; the queue's retry finishes it", async () => {
    const w = await place();
    const { sha } = await published(w);
    const names = namesClient({ ...FAKE, endpoint: emu!.endpoint });
    const send = names.send.bind(names);
    let fail = true;
    names.send = ((cmd: unknown, ...rest: unknown[]) => {
      if (fail && cmd instanceof PutItemCommand) {
        fail = false;
        return Promise.reject(Object.assign(new Error('throttled'), { name: 'ProvisionedThroughputExceededException' }));
      }
      return (send as (...a: unknown[]) => unknown)(cmd, ...rest);
    }) as typeof names.send;
    const logged: string[] = [];
    const indexer = openIndexer({ env: w.env, ddb: w.ddb, s3: w.s3, names, log: (l) => void logged.push(l) });
    const q = await queued(w.ddb, w.place);
    expect(await indexer(q)).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(await isNamed(w.ddb, w.place, sha)).toBe(false);
    expect(logged).toEqual(['indexer: message failed (ProvisionedThroughputExceededException)']);
    expect(await indexer(q)).toEqual({ batchItemFailures: [] });
    expect(await isNamed(w.ddb, w.place, sha)).toBe(true);
  });

  it('opens from its place alone: the API\'s settings are not needed', () => {
    expect(() => openIndexer({ env: { CATALOG_TABLE: 't', CATALOG_BUCKET: 'b' }, ...clients(), names: namesClient({ ...FAKE, endpoint: emu!.endpoint }), log: () => {} })).not.toThrow();
  });
});

describe('the sweep entry', () => {
  it('runs both passes from its place and answers how many files it deleted, marked and unmarked (never their names in the log)', async () => {
    const w = await place();
    await published(w);
    const logged: string[] = [];
    const sweep = openSweep({ env: { CATALOG_TABLE: w.place.table, CATALOG_BUCKET: w.place.bucket }, ddb: w.ddb, s3: w.s3, log: (l) => void logged.push(l) });
    expect(await sweep()).toEqual({ deleted: 0, marked: 0, unmarked: 0 });
    expect(logged).toEqual(['sweep: deleted 0, marked 0, unmarked 0']);
  });
});
