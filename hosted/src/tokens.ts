// The hosted catalog's Bearer tokens (contract §1.1 "Who's asking, hosted", "Getting a token, hosted"): a session from
// signing in with GitHub, or a personal token; each has an owner, a scope (read or publish), an expiry and a public id,
// and is kept only as its SHA-256 (item token#<hash>), with an item under its owner (tokens#<owner> / <id>) for listing
// and revoking by id. A token that's unknown, revoked or at its expiry is nobody. The token itself is shown once, at issue.

import { createHash, randomBytes } from 'node:crypto';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Clock, TokenHolder, TokenInfo, TokenKind, TokenScope, TokenStore } from '@skills-catalog/core';
import type { Place } from './place.ts';

export type { TokenHolder, TokenKind, TokenScope } from '@skills-catalog/core';

const SCOPES: readonly string[] = ['read', 'publish'];
const KINDS: readonly string[] = ['session', 'personal'];
/** How often a token's last use is written at most. */
export const LAST_USE_EVERY_MS = 60 * 60_000;

const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const tokenKey = (hash: string) => ({ pk: { S: `token#${hash}` }, sk: { S: 'token' } });
const ownerKey = (owner: string, id: string) => ({ pk: { S: `tokens#${owner}` }, sk: { S: id } });

export class HostedTokenStore implements TokenStore {
  private readonly p: { ddb: DynamoDBClient; place: Place; clock: Clock; log: (line: string) => void };

  constructor(parts: { ddb: DynamoDBClient; place: Place; clock: Clock; log?: (line: string) => void }) {
    this.p = { log: (line) => console.error(line), ...parts };
  }

  /** A new token (256 random bits, base64url) and its public id; only the token's hash is stored. */
  async issue(t: TokenHolder & { expiresAt: Date }): Promise<{ id: string; token: string }> {
    if (!SCOPES.includes(t.scope) || !KINDS.includes(t.kind)) throw new Error('a token has a read or publish scope and is a session or a personal token');
    if (!(t.expiresAt.getTime() > this.p.clock.now().getTime())) throw new Error("a token's expiry is in the future");
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(12).toString('base64url');
    const hash = hashOf(token);
    const fields = { owner: { S: t.owner }, scope: { S: t.scope }, kind: { S: t.kind }, expires_at: { S: t.expiresAt.toISOString() }, created_at: { S: this.p.clock.now().toISOString() }, id: { S: id } };
    const put = (key: Record<string, AttributeValue>, extra: Record<string, AttributeValue>) => ({
      Put: { TableName: this.p.place.table, Item: { ...key, ...fields, ...extra }, ConditionExpression: 'attribute_not_exists(pk)' },
    });
    await this.p.ddb.send(new TransactWriteItemsCommand({ TransactItems: [put(tokenKey(hash), {}), put(ownerKey(t.owner, id), { hash: { S: hash } })] }));
    return { id, token };
  }

  /** Who holds this token, or undefined when it's unknown, revoked or expired. Its last use is written at most once an
   *  hour, and a failed write never fails the request. */
  async verify(token: string): Promise<TokenHolder | undefined> {
    if (!token) return undefined;
    const hash = hashOf(token);
    const r = await this.p.ddb.send(new GetItemCommand({ TableName: this.p.place.table, Key: tokenKey(hash), ConsistentRead: true }));
    const i = r.Item;
    if (!i || i['revoked_at'] !== undefined) return undefined;
    const now = this.p.clock.now();
    if (!(Date.parse(i['expires_at']!.S!) > now.getTime())) return undefined;
    const holder = { owner: i['owner']!.S!, scope: i['scope']!.S! as TokenScope, kind: i['kind']!.S! as TokenKind };
    const last = i['last_used_at']?.S ? Date.parse(i['last_used_at'].S) : NaN;
    if (!(now.getTime() - last < LAST_USE_EVERY_MS)) await this.used(hash, holder.owner, i['id']!.S!, now);
    return holder;
  }

  private async used(hash: string, owner: string, id: string, now: Date): Promise<void> {
    const set = (key: Record<string, AttributeValue>) => ({
      Update: { TableName: this.p.place.table, Key: key, UpdateExpression: 'SET last_used_at = :at', ConditionExpression: 'attribute_exists(pk)', ExpressionAttributeValues: { ':at': { S: now.toISOString() } } },
    });
    try {
      await this.p.ddb.send(new TransactWriteItemsCommand({ TransactItems: [set(tokenKey(hash)), set(ownerKey(owner, id))] }));
    } catch (e) {
      this.p.log(`token last use: write failed (${e instanceof Error ? e.name : typeof e})`);
    }
  }

  /** This owner's tokens, oldest first: public id, scope, kind, times; never the token or its hash. */
  async list(owner: string): Promise<TokenInfo[]> {
    const out: TokenInfo[] = [];
    let start: Record<string, AttributeValue> | undefined;
    do {
      const r = await this.p.ddb.send(
        new QueryCommand({ TableName: this.p.place.table, KeyConditionExpression: 'pk = :pk', ExpressionAttributeValues: { ':pk': { S: `tokens#${owner}` } }, ExclusiveStartKey: start, ConsistentRead: true }),
      );
      for (const i of r.Items ?? []) {
        out.push({
          id: i['id']!.S!,
          owner: i['owner']!.S!,
          scope: i['scope']!.S! as TokenScope,
          kind: i['kind']!.S! as TokenKind,
          created_at: i['created_at']!.S!,
          expires_at: i['expires_at']!.S!,
          ...(i['last_used_at']?.S ? { last_used_at: i['last_used_at'].S } : {}),
          ...(i['revoked_at']?.S ? { revoked_at: i['revoked_at'].S } : {}),
        });
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return out.sort((a, b) => (a.created_at === b.created_at ? (a.id < b.id ? -1 : 1) : a.created_at < b.created_at ? -1 : 1));
  }

  /** The owner's token with this id no longer works: its records stay, marked with when it was revoked (the API's role
   *  deletes nothing). Another's id, or one that doesn't exist, changes nothing: false. */
  async revoke(owner: string, id: string): Promise<boolean> {
    const r = await this.p.ddb.send(new GetItemCommand({ TableName: this.p.place.table, Key: ownerKey(owner, id), ConsistentRead: true }));
    const hash = r.Item?.['hash']?.S;
    if (!hash) return false;
    const mark = (key: Record<string, AttributeValue>) => ({
      Update: {
        TableName: this.p.place.table,
        Key: key,
        UpdateExpression: 'SET revoked_at = if_not_exists(revoked_at, :at)',
        ConditionExpression: 'attribute_exists(pk)',
        ExpressionAttributeValues: { ':at': { S: this.p.clock.now().toISOString() } },
      },
    });
    await this.p.ddb.send(new TransactWriteItemsCommand({ TransactItems: [mark(tokenKey(hash)), mark(ownerKey(owner, id))] }));
    return true;
  }
}
