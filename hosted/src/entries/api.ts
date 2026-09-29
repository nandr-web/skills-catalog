// The API function's entry (contract §1.1): a hosted catalog over the table and the bucket its environment names, behind
// the origin guard and the GitHub sign-in, both reading their values from Parameter Store at run time. Opened once per
// container, on its first request; an open that fails is tried again by the next request (a missing setting fails
// each one, naming the setting in the log).

import { join } from 'node:path';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { SSMClient } from '@aws-sdk/client-ssm';
import { Catalog, Words, actAs, randomIds, type Clock, type GitHubSignIn } from '@skills-catalog/core';
import { createHostedHandler } from '../api/handler.ts';
import { lambdaAdapter, type HttpApiEvent, type HttpApiResult } from '../api/lambda.ts';
import { originGuard } from '../api/origin.ts';
import { deliveredByTheStream } from '../events.ts';
import { HostedGitHubSignIn } from '../github.ts';
import { HostedBlobLinks } from '../links.ts';
import type { Place } from '../place.ts';
import { S3SearchIndex } from '../search.ts';
import { HostedStorage } from '../storage.ts';
import { HostedTokenStore } from '../tokens.ts';
import { openOnce } from './once.ts';
import { parameterReader } from './parameters.ts';
import { apiSettings } from './settings.ts';

const systemClock: Clock = { now: () => new Date() };

/** A hosted catalog over one table and bucket, as the API function opens it (and a test that publishes beside it). */
export async function openHostedCatalog(p: {
  ddb: DynamoDBClient;
  s3: S3Client;
  place: Place;
  clock: Clock;
  signIn: GitHubSignIn;
  signInLogins: readonly string[];
  log?: (line: string) => void;
}): Promise<{ catalog: Catalog; tokens: HostedTokenStore }> {
  const { ddb, s3, place, clock } = p;
  const tokens = new HostedTokenStore({ ddb, place, clock, ...(p.log ? { log: p.log } : {}) });
  const catalog = await Catalog.open({
    where: 'hosted',
    links: new HostedBlobLinks({ s3, place, clock }),
    tokens,
    signIn: p.signIn,
    storage: new HostedStorage({ ddb, s3, place, clock }),
    index: new S3SearchIndex({ s3, place }),
    events: deliveredByTheStream,
    // Nobody acts by default: each request's caller comes from its token.
    identity: actAs(undefined),
    clock,
    ids: randomIds,
    config: { signInLogins: p.signInLogins },
  });
  return { catalog, tokens };
}

export async function openApi(p: {
  env: Record<string, string | undefined>;
  ddb: DynamoDBClient;
  s3: S3Client;
  ssm: Pick<SSMClient, 'send'>;
  words: Words;
  clock?: Clock;
  fetch?: typeof fetch;
  log?: (line: string) => void;
}): Promise<(e: HttpApiEvent) => Promise<HttpApiResult>> {
  const settings = apiSettings(p.env);
  const clock = p.clock ?? systemClock;
  const log = p.log ?? ((line: string) => console.error(line));
  const read = parameterReader(p.ssm);
  const signIn = new HostedGitHubSignIn({
    clientId: settings.github.clientId,
    // Unset, it's the catalog's failure (internal_error), never the person's.
    secret: async () => {
      const v = await read(settings.github.secretParameter);
      if (v === undefined) throw new Error("the GitHub app's secret parameter isn't set");
      return v;
    },
    clock,
    ...(p.fetch ? { fetch: p.fetch } : {}),
  });
  const { catalog, tokens } = await openHostedCatalog({ ddb: p.ddb, s3: p.s3, place: settings.place, clock, signIn, signInLogins: settings.signInLogins, log });
  const origin = originGuard({ names: settings.origin, read, clock, log });
  return lambdaAdapter(createHostedHandler({ catalog, tokens, words: p.words, origin, log }));
}

// Its words file is beside the bundle (the stack's build copies it there).
const api = openOnce(async () =>
  openApi({
    env: process.env,
    ddb: new DynamoDBClient({}),
    s3: new S3Client({}),
    ssm: new SSMClient({}),
    words: Words.load(undefined, join(import.meta.dirname, 'words.yaml')),
  }),
);

/** The function's handler. */
export async function handler(e: HttpApiEvent): Promise<HttpApiResult> {
  return (await api())(e);
}
