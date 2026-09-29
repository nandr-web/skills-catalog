// Publish events to the indexer (contract §7): the commit writes a version_published item in the table; the
// table's stream carries its insert through Pipes (event items only) into an SQS FIFO queue with one message group, so
// the one indexer takes events one at a time, in order. A message that keeps failing goes to a FIFO dead-letter queue.

import { Duration, type RemovalPolicy } from 'aws-cdk-lib';
import { PolicyStatement, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { CfnPipe } from 'aws-cdk-lib/aws-pipes';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import type { Storage } from './storage.ts';

export class Events extends Construct {
  readonly queue: Queue;
  readonly deadLetters: Queue;
  readonly pipe: CfnPipe;

  constructor(scope: Construct, id: string, p: { storage: Storage; indexer: IFunction; removal: RemovalPolicy }) {
    super(scope, id);
    const common = { fifo: true, encryption: QueueEncryption.SQS_MANAGED, enforceSSL: true, removalPolicy: p.removal };
    this.deadLetters = new Queue(this, 'DeadLetters', { ...common, retentionPeriod: Duration.days(14) });
    this.queue = new Queue(this, 'Queue', { ...common, visibilityTimeout: Duration.minutes(6), deadLetterQueue: { queue: this.deadLetters, maxReceiveCount: 5 } });

    const role = new Role(this, 'PipeRole', { assumedBy: new ServicePrincipal('pipes.amazonaws.com') });
    role.addToPolicy(new PolicyStatement({ actions: ['dynamodb:DescribeStream', 'dynamodb:GetRecords', 'dynamodb:GetShardIterator', 'dynamodb:ListStreams'], resources: [p.storage.table.tableStreamArn!] }));
    this.queue.grantSendMessages(role);

    this.pipe = new CfnPipe(this, 'Pipe', {
      roleArn: role.roleArn,
      source: p.storage.table.tableStreamArn!,
      sourceParameters: {
        dynamoDbStreamParameters: { startingPosition: 'TRIM_HORIZON', batchSize: 1 },
        filterCriteria: { filters: [{ pattern: JSON.stringify({ eventName: ['INSERT'], dynamodb: { Keys: { pk: { S: ['events'] } } } }) }] },
      },
      target: this.queue.queueArn,
      targetParameters: { sqsQueueParameters: { messageGroupId: 'catalog', messageDeduplicationId: '$.eventID' } },
    });

    p.indexer.addEventSource(new SqsEventSource(this.queue, { batchSize: 1 }));
  }
}
