// The hosted catalog's Bearer tokens (contract §1.1 "Who's asking, hosted"): a session from signing in with GitHub, or a
// personal token; each has an owner, a scope (read or publish) and an expiry, and is kept only as its SHA-256 (item
// token#<hash>). A token that's unknown, revoked or at its expiry is nobody. The token itself is shown once, at issue.

import { createHash, randomBytes } from 'node:crypto';
import { DeleteItemCommand, GetItemCommand, PutItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Clock } from '@skills-catalog/core';
import type { Place } from './place.ts';

export type TokenScope = 'read' | 'publish';
export type TokenKind = 'session' | 'personal';
export type TokenHolder = { owner: string; scope: TokenScope; kind: TokenKind };

const SCOPES: readonly string[] = ['read', 'publish'];
const KINDS: readonly string[] = ['session', 'personal'];
const keyOf = (token: string) => ({ pk: { S: `token#${createHash('sha256').update(token).digest('hex')}` }, sk: { S: 'token' } });

export class HostedTokenStore {
  private readonly p: { ddb: DynamoDBClient; place: Place; clock: Clock };

  constructor(parts: { ddb: DynamoDBClient; place: Place; clock: Clock }) {
    this.p = parts;
  }

  /** A new token (256 random bits, base64url); only its hash is stored. */
  async issue(t: TokenHolder & { expiresAt: Date }): Promise<string> {
    if (!SCOPES.includes(t.scope) || !KINDS.includes(t.kind)) throw new Error('a token has a read or publish scope and is a session or a personal token');
    if (!(t.expiresAt.getTime() > this.p.clock.now().getTime())) throw new Error("a token's expiry is in the future");
    const token = randomBytes(32).toString('base64url');
    await this.p.ddb.send(
      new PutItemCommand({
        TableName: this.p.place.table,
        Item: { ...keyOf(token), owner: { S: t.owner }, scope: { S: t.scope }, kind: { S: t.kind }, expires_at: { S: t.expiresAt.toISOString() } },
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return token;
  }

  /** Who holds this token, or undefined when it's unknown, revoked or expired. */
  async verify(token: string): Promise<TokenHolder | undefined> {
    if (!token) return undefined;
    const r = await this.p.ddb.send(new GetItemCommand({ TableName: this.p.place.table, Key: keyOf(token), ConsistentRead: true }));
    const i = r.Item;
    if (!i) return undefined;
    if (!(Date.parse(i['expires_at']!.S!) > this.p.clock.now().getTime())) return undefined;
    return { owner: i['owner']!.S!, scope: i['scope']!.S! as TokenScope, kind: i['kind']!.S! as TokenKind };
  }

  /** The token no longer works. (The API's role may delete only these items.) */
  async revoke(token: string): Promise<void> {
    await this.p.ddb.send(new DeleteItemCommand({ TableName: this.p.place.table, Key: keyOf(token) }));
  }
}
