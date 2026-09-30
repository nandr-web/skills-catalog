// The catalog's three functions and what each may do (contract §1.1, §7): the API (reads and writes records, uploads
// and tags files, never deletes), the indexer (writes the search file and each file's name record, never deletes) and
// the sweep (the only one that deletes, and only skill files). No role gets a batch write: DynamoDB's BatchWriteItem
// can delete as well as put, and no condition narrows it.

import { Duration, Stack, type RemovalPolicy } from 'aws-cdk-lib';
import { CfnStage, HttpApi, HttpMethod, HttpStage, LogGroupLogDestination } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import type { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { catalogFunction } from './function.ts';
import { BLOB_PREFIX, type Storage } from './storage.ts';

export const SEARCH_KEY = 'search/cards.json';

/** Signing in, the one route that takes no token: its path, its route, and its own throttle for all callers together:
 *  at most half of GitHub's hourly allowance for an OAuth app (5,000 requests an hour,
 *  https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#primary-rate-limit-for-oauth-apps),
 *  so a flood of made-up tokens can't use it up (contract §1.1). 0.6 a second is 2,160 an hour, plus one burst. */
export const SIGN_IN_PATH = '/api/v1/sign_in_with_github';
export const SIGN_IN_ROUTE = `POST ${SIGN_IN_PATH}`;
export const SIGN_IN_THROTTLE = { rate: 0.6, burst: 5 };

type Props = { entry: string; projectRoot: string; lockFile: string; storage: Storage; removal: RemovalPolicy; runtimeVersionArn?: string | undefined };
export type ApiProps = Props & {
  throttle: { rate: number; burst: number };
  githubSecretParameter: string;
  originSecretParameters: { current: string; previous: string };
  /** The GitHub app's client id and the sign-in list, as the deploy's parameters give them. */
  signIn: { clientId: string; logins: string };
  words: string;
};

const records = (s: Storage, actions: string[]) => new PolicyStatement({ actions: actions.map((a) => `dynamodb:${a}`), resources: [s.table.tableArn] });
const files = (s: Storage, actions: string[], key = `${BLOB_PREFIX}*`) => new PolicyStatement({ actions: actions.map((a) => `s3:${a}`), resources: [s.bucket.arnForObjects(key)] });
const listing = (s: Storage) => new PolicyStatement({ actions: ['s3:ListBucket'], resources: [s.bucket.bucketArn] });

/** The API function behind one HTTP API: every route goes to it (the handler routes), throttled, access logged. */
export class Api extends Construct {
  readonly fn: NodejsFunction;
  readonly http: HttpApi;

  constructor(scope: Construct, id: string, p: ApiProps) {
    super(scope, id);
    const origin = p.originSecretParameters;
    this.fn = catalogFunction(this, {
      ...p,
      environment: {
        GITHUB_SECRET_PARAMETER: p.githubSecretParameter,
        GITHUB_CLIENT_ID: p.signIn.clientId,
        SIGN_IN_LOGINS: p.signIn.logins,
        ORIGIN_SECRET_PARAMETER: origin.current,
        ORIGIN_SECRET_PREVIOUS_PARAMETER: origin.previous,
      },
    });
    // Records: read, the commit's transaction (put, conditional update, condition checks), token revokes (an update).
    this.fn.addToRolePolicy(records(p.storage, ['GetItem', 'Query', 'PutItem', 'UpdateItem', 'ConditionCheckItem']));
    // Files: upload links (put-if-absent), reading bytes to check them, claims (tags); the search file, read only.
    this.fn.addToRolePolicy(files(p.storage, ['GetObject', 'PutObject', 'GetObjectTagging', 'PutObjectTagging']));
    this.fn.addToRolePolicy(files(p.storage, ['GetObject'], SEARCH_KEY));
    this.fn.addToRolePolicy(listing(p.storage));
    // The GitHub sign-in app's secret and the origin secret (current and previous): those parameters, by name.
    const stack = Stack.of(this);
    const parameter = (name: string) => `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${name}`;
    this.fn.addToRolePolicy(new PolicyStatement({ actions: ['ssm:GetParameter'], resources: [p.githubSecretParameter, origin.current, origin.previous].map(parameter) }));

    const integration = new HttpLambdaIntegration('Handler', this.fn);
    this.http = new HttpApi(this, 'Http', { defaultIntegration: integration, createDefaultStage: false });
    // Signing in goes to the same function by a route of its own, so the stage can throttle it on its own.
    const signInRoutes = this.http.addRoutes({ path: SIGN_IN_PATH, methods: [HttpMethod.POST], integration });
    const stage = new HttpStage(this, 'Stage', {
      httpApi: this.http,
      stageName: '$default',
      autoDeploy: true,
      throttle: { rateLimit: p.throttle.rate, burstLimit: p.throttle.burst },
      accessLogSettings: { destination: new LogGroupLogDestination(new LogGroup(this, 'AccessLogs', { retention: RetentionDays.ONE_MONTH, removalPolicy: p.removal })) },
    });
    // The throttle below names the sign-in route, which must exist before the stage (CloudFormation's order otherwise).
    for (const r of signInRoutes) stage.node.addDependency(r);
    (stage.node.defaultChild as CfnStage).addPropertyOverride('RouteSettings', {
      [SIGN_IN_ROUTE]: { ThrottlingRateLimit: SIGN_IN_THROTTLE.rate, ThrottlingBurstLimit: SIGN_IN_THROTTLE.burst },
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
    // A missing search file (before the first publish) is then 404, not 403 AccessDenied.
    this.fn.addToRolePolicy(listing(p.storage));
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
