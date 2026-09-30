// How the stack's parts connect: an HTTP API whose every route goes to the API function, throttled, signing in the more
// so; publish events from the table's stream through Pipes into an SQS FIFO queue with one message group, so the one
// indexer takes them in order; the sweep on a schedule; the GitHub sign-in secret only as a parameter store name (the
// owner creates it; never in the template), its app's client id and the sign-in list as the deploy's parameters.

import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { SIGN_IN_ROUTE, SIGN_IN_THROTTLE } from '../src/constructs/functions.ts';
import { synth } from './synth.ts';

const t = synth('throwaway');
/** The logical id of the one function whose id starts with `prefix`. */
const ref = (prefix: string) => {
  const ids = Object.keys(t.findResources('AWS::Lambda::Function')).filter((k) => k.startsWith(prefix));
  if (ids.length !== 1) throw new Error(`${ids.length} functions ${prefix}…`);
  return ids[0]!;
};

describe('the HTTP API', () => {
  it('one HTTP API; its default route goes to the API function', () => {
    t.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { ProtocolType: 'HTTP' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Route', { RouteKey: '$default' });
    t.hasResourceProperties('AWS::ApiGatewayV2::Integration', { IntegrationType: 'AWS_PROXY', PayloadFormatVersion: '2.0', IntegrationUri: { 'Fn::GetAtt': [ref('ApiHandler'), 'Arn'] } });
  });

  it('its stage is throttled and logs its access', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      StageName: '$default',
      AutoDeploy: true,
      DefaultRouteSettings: { ThrottlingRateLimit: Match.anyValue(), ThrottlingBurstLimit: Match.anyValue() },
      AccessLogSettings: { DestinationArn: Match.anyValue() },
    });
  });

  it("signing in has its own route to the same function, throttled in total below GitHub's hourly allowance for our app (contract §1.1)", () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r: any) => r.Properties.RouteKey).sort();
    expect(routes).toEqual(['$default', SIGN_IN_ROUTE]);
    const targets = new Set(Object.values(t.findResources('AWS::ApiGatewayV2::Route')).map((r: any) => JSON.stringify(r.Properties.Target)));
    expect(targets.size).toBe(1);
    const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0] as any;
    expect(stage.Properties.RouteSettings[SIGN_IN_ROUTE]).toEqual({ ThrottlingRateLimit: SIGN_IN_THROTTLE.rate, ThrottlingBurstLimit: SIGN_IN_THROTTLE.burst });
    // An hour at the rate, and one burst, stay within half of GitHub's 5,000 requests an hour for an OAuth app.
    expect(SIGN_IN_THROTTLE.rate * 3600 + SIGN_IN_THROTTLE.burst).toBeLessThanOrEqual(2500);
  });
});

describe("the API's sign-in settings are the deploy's, never in code", () => {
  it("the GitHub app's client id and the sign-in list are stack parameters, given to the API function by reference", () => {
    const params = t.toJSON().Parameters as Record<string, { Type: string; Default?: string; MinLength?: number }>;
    expect(params['GitHubClientId']).toMatchObject({ Type: 'String', MinLength: 1 });
    expect(params['GitHubClientId']!.Default).toBeUndefined();
    // Empty is nobody: a deploy that names no one lets no one sign in.
    expect(params['SignInLogins']).toMatchObject({ Type: 'String', Default: '' });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ GITHUB_CLIENT_ID: { Ref: 'GitHubClientId' }, SIGN_IN_LOGINS: { Ref: 'SignInLogins' } }) },
    });
  });
});

describe('publish events to the indexer', () => {
  it('a FIFO queue, encrypted, with a FIFO dead-letter queue', () => {
    t.hasResourceProperties('AWS::SQS::Queue', { FifoQueue: true, SqsManagedSseEnabled: true, RedrivePolicy: { deadLetterTargetArn: Match.anyValue(), maxReceiveCount: Match.anyValue() } });
    expect(Object.keys(t.findResources('AWS::SQS::Queue', { Properties: { FifoQueue: true } })).length).toBe(2);
  });

  it('a pipe from the table stream, inserts of event items only, to the queue in one message group', () => {
    t.hasResourceProperties('AWS::Pipes::Pipe', {
      Source: { 'Fn::GetAtt': [Match.stringLikeRegexp('^StorageTable'), 'StreamArn'] },
      SourceParameters: {
        DynamoDBStreamParameters: { StartingPosition: 'TRIM_HORIZON' },
        FilterCriteria: { Filters: [{ Pattern: JSON.stringify({ eventName: ['INSERT'], dynamodb: { Keys: { pk: { S: ['events'] } } } }) }] },
      },
      TargetParameters: { SqsQueueParameters: { MessageGroupId: 'catalog', MessageDeduplicationId: '$.eventID' } },
    });
  });

  it('the indexer takes the queue one message at a time, reporting the messages that failed so only those come again', () => {
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', { FunctionName: { Ref: ref('IndexerHandler') }, BatchSize: 1, FunctionResponseTypes: ['ReportBatchItemFailures'] });
  });
});

describe('the sweep and sign-in', () => {
  it('the sweep runs on a schedule', () => {
    t.hasResourceProperties('AWS::Events::Rule', { ScheduleExpression: Match.stringLikeRegexp('^rate\\('), Targets: [Match.objectLike({ Arn: { 'Fn::GetAtt': [ref('SweepHandler'), 'Arn'] } })] });
  });

  it('the GitHub secret is only a parameter name: the API may read that one parameter, and no secret value is in the template', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ GITHUB_SECRET_PARAMETER: Match.stringLikeRegexp('^/skills-catalog/') }) } });
    t.hasResourceProperties('AWS::IAM::Policy', { PolicyDocument: { Statement: Match.arrayWith([Match.objectLike({ Action: 'ssm:GetParameter' })]) } });
    t.resourceCountIs('AWS::SSM::Parameter', 0);
    t.resourceCountIs('AWS::SecretsManager::Secret', 0);
  });
});

describe("each function's role", () => {
  it('has no managed policy, and writes logs only to its own log group', () => {
    // the catalog's three (CDK's own auto-delete helper on the throwaway preset is not one of them)
    const fns = (Object.values(t.findResources('AWS::Lambda::Function')) as any[]).filter((f) => f.Properties.LoggingConfig);
    expect(fns.length).toBe(3);
    const roles = t.findResources('AWS::IAM::Role') as Record<string, any>;
    const policies = Object.values(t.findResources('AWS::IAM::Policy')) as any[];
    for (const fn of fns) {
      const roleId = fn.Properties.Role['Fn::GetAtt'][0];
      expect(roles[roleId].Properties.ManagedPolicyArns ?? [], roleId).toEqual([]);
      const logGroup = fn.Properties.LoggingConfig.LogGroup.Ref;
      const statements = policies.filter((p) => p.Properties.Roles.some((r: any) => r.Ref === roleId)).flatMap((p) => p.Properties.PolicyDocument.Statement);
      const logs = statements.filter((s) => [s.Action].flat().some((a: string) => a.startsWith('logs:')));
      expect(logs.length, roleId).toBeGreaterThan(0);
      for (const s of logs) for (const r of [s.Resource].flat()) expect(JSON.stringify(r), roleId).toContain(logGroup);
    }
  });
});

describe('the stage and its routes', () => {
  it("the stage is made after the sign-in route its throttle names (CloudFormation refuses a RouteSettings key for a route that isn't there yet)", () => {
    const routes = t.findResources('AWS::ApiGatewayV2::Route') as Record<string, any>;
    const signIn = Object.entries(routes).find(([, r]) => r.Properties.RouteKey === SIGN_IN_ROUTE)![0];
    const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0] as any;
    expect([stage.DependsOn ?? []].flat()).toContain(signIn);
  });
});

describe('reading the search file before it exists', () => {
  it("the indexer may list the bucket, so S3 answers a missing search file 404 (without it, AWS answers 403 AccessDenied, which moto doesn't)", () => {
    const fns = t.findResources('AWS::Lambda::Function') as Record<string, any>;
    const [, indexer] = Object.entries(fns).find(([id]) => id.startsWith('IndexerHandler'))!;
    const roleId = indexer.Properties.Role['Fn::GetAtt'][0];
    const statements = (Object.values(t.findResources('AWS::IAM::Policy')) as any[])
      .filter((p) => p.Properties.Roles.some((r: any) => r.Ref === roleId))
      .flatMap((p) => p.Properties.PolicyDocument.Statement);
    expect(statements.some((s) => [s.Action].flat().includes('s3:ListBucket'))).toBe(true);
  });
});
