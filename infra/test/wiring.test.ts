// How the stack's parts connect (the AWS build brief, slice 3): an HTTP API whose every route goes to the API
// function, throttled; publish events from the table's stream through Pipes into an SQS FIFO queue with one message
// group, so the one indexer takes them in order; the sweep on a schedule; the GitHub sign-in secret only as a parameter
// store name (the owner creates it; never in the template).

import { Match } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { synth } from './synth.ts';

const t = synth('throwaway');
const ref = (prefix: string) => {
  const id = Object.keys(t.toJSON().Resources).find((k) => k.startsWith(prefix));
  if (!id) throw new Error(`no resource ${prefix}…`);
  return id;
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

  it('the indexer takes the queue one message at a time', () => {
    t.hasResourceProperties('AWS::Lambda::EventSourceMapping', { FunctionName: { Ref: ref('IndexerHandler') }, BatchSize: 1 });
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
