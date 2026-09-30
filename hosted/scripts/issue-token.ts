// npm run issue-token -- --table <CATALOG_TABLE> --owner <github login> [--scope publish|read] [--days 30] [--region us-east-1]
// A personal token for a deployed catalog, issued by whoever holds the AWS account (contract §1.1: a sign-in session or
// a personal token). Only its hash is stored; the token is printed once, here. Uses your own AWS credentials (the
// default chain); the table's name is the API function's CATALOG_TABLE (the deploy plan prints how to read it).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { parseArgs } from 'node:util';
import { HostedTokenStore } from '../src/tokens.ts';

const { values } = parseArgs({ options: { table: { type: 'string' }, owner: { type: 'string' }, scope: { type: 'string', default: 'publish' }, days: { type: 'string', default: '30' }, region: { type: 'string', default: 'us-east-1' } } });
const days = Number(values.days);
if (!values.table || !values.owner || !/^[a-z0-9-]{1,39}$/.test(values.owner) || (values.scope !== 'publish' && values.scope !== 'read') || !(days > 0 && days <= 365)) {
  console.error('issue-token: --table <CATALOG_TABLE> --owner <github login, lowercase> [--scope publish|read] [--days 1..365]');
  process.exit(2);
}
const ddb = new DynamoDBClient({ region: values.region });
const store = new HostedTokenStore({ ddb, place: { table: values.table, bucket: '' }, clock: { now: () => new Date() } });
const expiresAt = new Date(Date.now() + days * 86_400_000);
const { id, token } = await store.issue({ owner: values.owner, scope: values.scope, kind: 'personal', expiresAt });
ddb.destroy();
console.error(`Issued a ${values.scope} token for ${values.owner} (id ${id}), until ${expiresAt.toISOString()}. It is shown once, below:`);
console.log(token);
