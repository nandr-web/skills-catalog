// The catalog's three functions and what each may do (contract §1.1, §7): the API (reads and writes records, uploads
// and tags files, never deletes), the indexer (writes the search file and each file's name record, never deletes) and
// the sweep (the only one that deletes, and only skill files). No role gets a batch write: DynamoDB's BatchWriteItem
// can delete as well as put, and no condition narrows it.

import { Duration, Stack, type RemovalPolicy } from 'aws-cdk-lib';
import { HttpApi, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { catalogFunction } from './function.ts';
import { BLOB_PREFIX, type Storage } from './storage.ts';

const SEARCH_KEY = 'search/cards.json';

type Props = { entry: string; projectRoot: string; storage: Storage; removal: RemovalPolicy };
export type ApiProps = Props & { throttle: { rate: number; burst: number }; githubSecretParameter: string };

const records = (s: Storage, actions: string[]) => new PolicyStatement({ actions: actions.map((a) => `dynamodb:${a}`), resources: [s.table.tableArn] });
const files = (s: Storage, actions: string[], key = `${BLOB_PREFIX}*`) => new PolicyStatement({ actions: actions.map((a) => `s3:${a}`), resources: [s.bucket.arnForObjects(key)] });
const listing = (s: Storage) => new PolicyStatement({ actions: ['s3:ListBucket'], resources: [s.bucket.bucketArn] });

/** The API function behind one HTTP API: every route goes to it (the handler routes), throttled, access logged. */
export class Api extends Construct {
  readonly fn: NodejsFunction;
  readonly http: HttpApi;

  constructor(scope: Construct, id: string, p: ApiProps) {
    super(scope, id);
    this.fn = catalogFunction(this, { ...p, environment: { GITHUB_SECRET_PARAMETER: p.githubSecretParameter } });
    // Records: read, the commit's transaction (put, conditional update, condition checks), token revokes (an update).
    this.fn.addToRolePolicy(records(p.storage, ['GetItem', 'Query', 'PutItem', 'UpdateItem', 'ConditionCheckItem']));
    // Files: upload links (put-if-absent), reading bytes to check them, claims (tags); the search file, read only.
    this.fn.addToRolePolicy(files(p.storage, ['GetObject', 'PutObject', 'GetObjectTagging', 'PutObjectTagging']));
    this.fn.addToRolePolicy(files(p.storage, ['GetObject'], SEARCH_KEY));
    this.fn.addToRolePolicy(listing(p.storage));
    // The GitHub sign-in app's secret: that one parameter, by name.
    const stack = Stack.of(this);
    this.fn.addToRolePolicy(new PolicyStatement({ actions: ['ssm:GetParameter'], resources: [`arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${p.githubSecretParameter}`] }));

    this.http = new HttpApi(this, 'Http', { defaultIntegration: new HttpLambdaIntegration('Handler', this.fn), createDefaultStage: false });
    new HttpStage(this, 'Stage', {
      httpApi: this.http,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: p.throttle.rate, burstLimit: p.throttle.burst },
      accessLogSettings: { destination: new LogGroupLogDestination(new LogGroup(this, 'AccessLogs', { retention: RetentionDays.ONE_MONTH, removalPolicy: p.removal })) },
    });
  }
}

export class Indexer extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, p: Props) {
    super(scope, id);
    this.fn = catalogFunction(this, { ...p, timeout: Duration.minutes(1) });
    this.fn.addToRolePolicy(records(p.storage, ['GetItem', 'Query', 'PutItem', 'UpdateItem']));
    this.fn.addToRolePolicy(files(p.storage, ['GetObject', 'PutObject'], SEARCH_KEY));
  }
}

export class Sweep extends Construct {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, p: Props) {
    super(scope, id);
    this.fn = catalogFunction(this, { ...p, timeout: Duration.minutes(15) });
    this.fn.addToRolePolicy(records(p.storage, ['Scan']));
    this.fn.addToRolePolicy(files(p.storage, ['GetObject', 'GetObjectTagging', 'PutObjectTagging']));
    // The one delete in the stack, in a statement of its own: skill files only.
    this.fn.addToRolePolicy(new PolicyStatement({ actions: ['s3:DeleteObject'], resources: [p.storage.bucket.arnForObjects(`${BLOB_PREFIX}*`)] }));
    this.fn.addToRolePolicy(listing(p.storage));
    // Each run marks, and deletes what an earlier run marked at least an hour ago.
    new Rule(this, 'Schedule', { schedule: Schedule.rate(Duration.hours(1)), targets: [new LambdaFunction(this.fn)] });
  }
}
