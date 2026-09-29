// Guard rails around the stack (the plan page's list): an alerts topic, an alarm when an event is lost (a message in
// the dead-letter queue, or a failed pipe run: a missed version_published leaves a version's file names unwritten until
// the rebuild from versions), and, for demo, a monthly budget alarm and the flat-rate Free plan for the edge.

import { Stack } from 'aws-cdk-lib';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { CfnSubscription } from 'aws-cdk-lib/aws-pricingplanmanager';
import { Topic } from 'aws-cdk-lib/aws-sns';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export type GuardrailsProps = {
  deadLetters: Queue;
  pipeName: string;
  /** Demo: a monthly budget in US dollars, alarmed at 80% of actual spend. */
  budgetUsd?: number | undefined;
  /** Demo: the distribution and its web ACL on CloudFront's flat-rate Free plan. */
  freePlan?: { distributionArn: string; webAclArn: string } | undefined;
};

export class Guardrails extends Construct {
  readonly alerts: Topic;

  constructor(scope: Construct, id: string, p: GuardrailsProps) {
    super(scope, id);
    this.alerts = new Topic(this, 'Alerts', { enforceSSL: true });
    const alarm = (name: string, metric: Metric) =>
      new Alarm(this, name, { metric, threshold: 0, evaluationPeriods: 1, comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD, treatMissingData: TreatMissingData.NOT_BREACHING }).addAlarmAction(new SnsAction(this.alerts));
    alarm('LostEvents', p.deadLetters.metricApproximateNumberOfMessagesVisible({ statistic: 'Maximum' }));
    alarm('PipeFailures', new Metric({ namespace: 'AWS/EventBridge/Pipes', metricName: 'ExecutionFailed', dimensionsMap: { PipeName: p.pipeName }, statistic: 'Sum' }));

    if (p.budgetUsd !== undefined) {
      this.alerts.addToResourcePolicy(new PolicyStatement({ actions: ['sns:Publish'], principals: [new ServicePrincipal('budgets.amazonaws.com')], resources: [this.alerts.topicArn], conditions: { StringEquals: { 'aws:SourceAccount': Stack.of(this).account } } }));
      new CfnBudget(this, 'Budget', {
        budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: p.budgetUsd, unit: 'USD' } },
        notificationsWithSubscribers: [{ notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' }, subscribers: [{ subscriptionType: 'SNS', address: this.alerts.topicArn }] }],
      });
    }
    if (p.freePlan) new CfnSubscription(this, 'FreePlan', { planFamily: 'CloudFront', planTier: 'FREE', usageLevel: 'DEFAULT', resourceArns: [p.freePlan.distributionArn, p.freePlan.webAclArn] });
  }
}
