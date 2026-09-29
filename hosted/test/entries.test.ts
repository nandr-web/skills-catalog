// The functions' entries, the parts that need no stand-in: their settings from the environment, the parameter reader,
// the origin guard on a first deploy, and the indexer's queue handling. Each entry's whole wiring runs on the stand-in
// in entries-wired.test.ts.

import { GetParameterCommand, ParameterNotFound } from '@aws-sdk/client-ssm';
import type { VersionPublished } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { originGuard } from '../src/api/origin.ts';
import { apiSettings, indexerSettings, onQueue, parameterReader, sweepSettings, versionPublishedOf, type QueueEvent } from '../src/entries/index.ts';

const clock = { now: () => new Date('2026-09-29T12:00:00Z') };
const CURRENT = 'c'.repeat(40);

const API_ENV = {
  CATALOG_TABLE: 'skills',
  CATALOG_BUCKET: 'skills-catalog',
  ORIGIN_SECRET_PARAMETER: '/catalog/origin',
  ORIGIN_SECRET_PREVIOUS_PARAMETER: '/catalog/origin-previous',
  GITHUB_SECRET_PARAMETER: '/catalog/github-secret',
  GITHUB_CLIENT_ID: 'Iv1.abc',
  SIGN_IN_LOGINS: 'Octocat, hubot ,,',
};

describe("the entries' settings", () => {
  it('the API reads its place, its parameters by name, the client id and the sign-in list (trimmed, no blanks)', () => {
    expect(apiSettings(API_ENV)).toEqual({
      place: { table: 'skills', bucket: 'skills-catalog' },
      origin: { current: '/catalog/origin', previous: '/catalog/origin-previous' },
      github: { clientId: 'Iv1.abc', secretParameter: '/catalog/github-secret' },
      signInLogins: ['Octocat', 'hubot'],
    });
  });

  it('an empty sign-in list is nobody, and is allowed', () => {
    expect(apiSettings({ ...API_ENV, SIGN_IN_LOGINS: '' }).signInLogins).toEqual([]);
  });

  it.each(Object.keys(API_ENV))('the API without %s fails at start, naming the setting and no value', (name) => {
    const env: Record<string, string | undefined> = { ...API_ENV, [name]: undefined };
    expect(() => apiSettings(env)).toThrow(name);
    try {
      apiSettings(env);
    } catch (e) {
      for (const v of Object.values(API_ENV).filter((v) => v.length > 4)) expect((e as Error).message).not.toContain(v);
    }
  });

  it('a blank setting other than the sign-in list is as missing', () => {
    expect(() => apiSettings({ ...API_ENV, GITHUB_CLIENT_ID: ' ' })).toThrow('GITHUB_CLIENT_ID');
  });

  it('the indexer and the sweep read only their place', () => {
    const place = { CATALOG_TABLE: 'skills', CATALOG_BUCKET: 'skills-catalog' };
    expect(indexerSettings(place)).toEqual({ place: { table: 'skills', bucket: 'skills-catalog' } });
    expect(sweepSettings(place)).toEqual({ place: { table: 'skills', bucket: 'skills-catalog' } });
    expect(() => sweepSettings({ CATALOG_TABLE: 'skills' })).toThrow('CATALOG_BUCKET');
  });
});

/** An SSM client's stand-in: each GetParameter answered from the map; a name not in it is ParameterNotFound. */
function ssm(values: Record<string, string | Error>) {
  const asked: { Name?: string | undefined; WithDecryption?: boolean | undefined }[] = [];
  return {
    asked,
    send: async (cmd: unknown) => {
      if (!(cmd instanceof GetParameterCommand)) throw new Error('only GetParameter');
      asked.push(cmd.input);
      const v = values[cmd.input.Name!];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new ParameterNotFound({ message: 'not found', $metadata: {} });
      return { Parameter: { Name: cmd.input.Name, Value: v } };
    },
  };
}

describe('the parameter reader', () => {
  it('reads a parameter by name, decrypted', async () => {
    const s = ssm({ '/p': 'value' });
    expect(await parameterReader(s)('/p')).toBe('value');
    expect(s.asked).toEqual([{ Name: '/p', WithDecryption: true }]);
  });

  it('a parameter that was never set is undefined, not a failure', async () => {
    expect(await parameterReader(ssm({}))('/missing')).toBeUndefined();
  });

  it('any other failure (no permission, throttled) is thrown', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    await expect(parameterReader(ssm({ '/p': denied }))('/p')).rejects.toThrow('denied');
  });

  it("a first deploy, with no previous origin value yet, accepts the current one", async () => {
    const guard = originGuard({ names: { current: '/o', previous: '/o-prev' }, read: parameterReader(ssm({ '/o': CURRENT })), clock, log: () => {} });
    expect(await guard.allows(CURRENT)).toBe(true);
    expect(await guard.allows('x'.repeat(40))).toBe(false);
  });

  it('with neither origin value set, every request is refused', async () => {
    const guard = originGuard({ names: { current: '/o', previous: '/o-prev' }, read: parameterReader(ssm({})), clock, log: () => {} });
    expect(await guard.allows(CURRENT)).toBe(false);
  });
});

const EVENT: VersionPublished = { type: 'version_published', name: 'pdf', version: 2, fingerprint: 'f'.repeat(64), publisher: 'dev1', at: '2026-09-29T12:00:00.000Z' };

/** The queue message the pipe sends for an event item's insert: the stream record as JSON. */
function streamBody(e: VersionPublished | Record<string, unknown>, over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    eventID: 'e1',
    eventName: 'INSERT',
    eventSource: 'aws:dynamodb',
    dynamodb: {
      Keys: { pk: { S: 'events' }, sk: { S: `${EVENT.at}#pdf#2` } },
      NewImage: { pk: { S: 'events' }, sk: { S: `${EVENT.at}#pdf#2` }, event: { S: JSON.stringify(e) }, delivered: { BOOL: false } },
    },
    ...over,
  });
}

const queue = (...bodies: string[]): QueueEvent => ({ Records: bodies.map((body, i) => ({ messageId: `m${i + 1}`, body })) });

describe("the indexer's queue", () => {
  it('reads version_published from the stream record the pipe sends', () => {
    expect(versionPublishedOf(streamBody(EVENT))).toEqual(EVENT);
  });

  it.each([
    ['not JSON', '{'],
    ['no new image', JSON.stringify({ eventName: 'INSERT', dynamodb: { Keys: {} } })],
    ['another item', streamBody(EVENT, { dynamodb: { NewImage: { pk: { S: 'skills' }, sk: { S: 'pdf' } } } })],
    ['an event of another type', streamBody({ ...EVENT, type: 'skill_deleted' })],
    ['a version that is no number', streamBody({ ...EVENT, version: '2' })],
    ['no name', streamBody({ ...EVENT, name: undefined })],
  ])('%s is no event: thrown', (_, body) => {
    expect(() => versionPublishedOf(body)).toThrow();
  });

  it('each message is handed on in order; all handled answers no failures', async () => {
    const seen: string[] = [];
    const r = await onQueue(async (e) => void seen.push(`${e.name}@${e.version}`), () => {})(queue(streamBody(EVENT), streamBody({ ...EVENT, version: 3 })));
    expect(seen).toEqual(['pdf@2', 'pdf@3']);
    expect(r).toEqual({ batchItemFailures: [] });
  });

  it('a message that fails is reported, with every one after it unhandled (the queue keeps its order)', async () => {
    const seen: number[] = [];
    const r = await onQueue(
      async (e) => {
        if (e.version === 3) throw new Error('throttled');
        seen.push(e.version);
      },
      () => {},
    )(queue(streamBody(EVENT), streamBody({ ...EVENT, version: 3 }), streamBody({ ...EVENT, version: 4 })));
    expect(seen).toEqual([2]);
    expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm2' }, { itemIdentifier: 'm3' }] });
  });

  it("a malformed message is a failure too (it goes to the dead-letter queue after its retries), logged by the error's name only", async () => {
    const lines: string[] = [];
    const r = await onQueue(async () => {}, (l) => void lines.push(l))(queue('{"secret-ish": '));
    expect(r).toEqual({ batchItemFailures: [{ itemIdentifier: 'm1' }] });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('secret-ish');
  });
});
