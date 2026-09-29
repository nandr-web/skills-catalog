// The site and the edge (the web build notes): one CloudFront distribution in front of a private site bucket (by
// origin access control) and the HTTP API (/api/*, never cached, same origin so no CORS), behind a web ACL. Its settings
// stay within what CloudFront's flat-rate Free plan allows, in both presets: ≤ 5 WAF rules and no custom rule groups,
// ≤ 5 cache behaviors, managed cache, origin-request and response-header policies only, no legacy forwarded values, no
// origin access identity. Demo subscribes the distribution and its web ACL to the Free plan and pins the functions'
// exact runtime version; throwaway pays as it goes. Demo has a budget alarm.

import { Match, type Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { synth } from './synth.ts';

type Res = Record<string, { Type: string; Properties?: Record<string, any> }>;
const distribution = (t: Template) => Object.values(t.findResources('AWS::CloudFront::Distribution'))[0]!.Properties.DistributionConfig;

for (const preset of ['throwaway', 'demo'] as const) {
  describe(`the site and edge within the Free plan's limits [${preset}]`, () => {
    const t = synth(preset);

    it('one distribution, https only, with a web ACL attached', () => {
      t.resourceCountIs('AWS::CloudFront::Distribution', 1);
      const d = distribution(t);
      expect(d.DefaultCacheBehavior.ViewerProtocolPolicy).toBe('redirect-to-https');
      expect(d.WebACLId).toBeDefined();
      t.hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
    });

    it('at most 5 WAF rules, managed groups or a rate limit only, and no custom rule groups', () => {
      const acl = Object.values(t.findResources('AWS::WAFv2::WebACL'))[0]!.Properties;
      expect(acl.Rules.length).toBeLessThanOrEqual(5);
      for (const r of acl.Rules) expect(Object.keys(r.Statement), r.Name).toEqual([expect.stringMatching(/^(ManagedRuleGroupStatement|RateBasedStatement)$/)]);
      t.resourceCountIs('AWS::WAFv2::RuleGroup', 0);
    });

    it('at most 5 cache behaviors; /api/* goes to the HTTP API, all methods, never cached', () => {
      const d = distribution(t);
      expect(1 + (d.CacheBehaviors?.length ?? 0)).toBeLessThanOrEqual(5);
      const api = d.CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === '/api/*');
      expect(api.AllowedMethods).toEqual(['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'POST', 'DELETE']);
      expect(api.CachePolicyId).toBe('4135ea2d-6df8-44a3-9df3-4b5a84be39ad'); // Managed-CachingDisabled
    });

    it('managed policies only, no legacy forwarded values, no CloudFront functions', () => {
      for (const type of ['AWS::CloudFront::CachePolicy', 'AWS::CloudFront::OriginRequestPolicy', 'AWS::CloudFront::ResponseHeadersPolicy', 'AWS::CloudFront::Function']) t.resourceCountIs(type, 0);
      expect(JSON.stringify(distribution(t))).not.toContain('ForwardedValues');
    });

    it('the site bucket is private and reached by origin access control, never an origin access identity', () => {
      t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
      t.resourceCountIs('AWS::CloudFront::CloudFrontOriginAccessIdentity', 0);
      expect(Object.keys(t.findResources('AWS::S3::Bucket', { Properties: { PublicAccessBlockConfiguration: { BlockPublicPolicy: true } } })).length).toBeGreaterThanOrEqual(2);
    });
  });
}

describe('the edge is the only way in', () => {
  const t = synth('throwaway');

  it("CloudFront sends the origin secret to the API as a header, its value a parameter reference, never a literal", () => {
    const api = distribution(t).Origins.find((o: { CustomOriginConfig?: unknown }) => o.CustomOriginConfig);
    expect(api.OriginCustomHeaders).toEqual([{ HeaderName: 'x-skills-catalog-origin', HeaderValue: expect.stringMatching(/^\{\{resolve:ssm:\/skills-catalog\/throwaway\/origin-secret\}\}$/) }]);
  });

  it('the API function is told which parameters hold it (current and previous, for rotation) and may read exactly those and the GitHub one', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ ORIGIN_SECRET_PARAMETER: '/skills-catalog/throwaway/origin-secret', ORIGIN_SECRET_PREVIOUS_PARAMETER: '/skills-catalog/throwaway/origin-secret-previous' }) } });
    const ssm = Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p: any) => p.Properties.PolicyDocument.Statement).filter((s: any) => s.Action === 'ssm:GetParameter');
    expect(ssm.length).toBe(1);
    const names = (ssm[0].Resource as any[]).map((r) => JSON.stringify(r).match(/:parameter(\/[^"]+)/)![1]);
    expect(names).toEqual(['/skills-catalog/throwaway/github-oauth-secret', '/skills-catalog/throwaway/origin-secret', '/skills-catalog/throwaway/origin-secret-previous']);
  });
});

describe('lost events raise an alarm', () => {
  for (const preset of ['throwaway', 'demo'] as const) {
    it(`a message in the dead-letter queue, and a failed pipe run, each raise an alarm to the alerts topic [${preset}]`, () => {
      const t = synth(preset);
      t.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/SQS', MetricName: 'ApproximateNumberOfMessagesVisible', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', AlarmActions: [Match.anyValue()] });
      t.hasResourceProperties('AWS::CloudWatch::Alarm', { Namespace: 'AWS/EventBridge/Pipes', MetricName: 'ExecutionFailed', Threshold: 0, ComparisonOperator: 'GreaterThanThreshold', AlarmActions: [Match.anyValue()] });
      t.resourceCountIs('AWS::SNS::Topic', 1);
    });
  }
});

describe('demo only', () => {
  it('subscribes the distribution and its web ACL to the flat-rate Free plan; throwaway does not', () => {
    const demo = synth('demo');
    demo.hasResourceProperties('AWS::PricingPlanManager::Subscription', {
      PlanFamily: 'CloudFront',
      PlanTier: 'FREE',
      UsageLevel: 'DEFAULT',
      ResourceArns: [Match.anyValue(), Match.anyValue()],
    });
    synth('throwaway').resourceCountIs('AWS::PricingPlanManager::Subscription', 0);
  });

  it('a budget alarm; throwaway has none', () => {
    synth('demo').resourceCountIs('AWS::Budgets::Budget', 1);
    synth('throwaway').resourceCountIs('AWS::Budgets::Budget', 0);
  });

  it("pins every catalog function's exact runtime version, and can't be made without one", () => {
    const demo = synth('demo');
    const fns = Object.entries(demo.toJSON().Resources as Res).filter(([id, r]) => r.Type === 'AWS::Lambda::Function' && /^(Api|Indexer|Sweep)Handler/.test(id));
    expect(fns.length).toBe(3);
    for (const [id, f] of fns) expect(f.Properties!['RuntimeManagementConfig'], id).toEqual({ UpdateRuntimeOn: 'Manual', RuntimeVersionArn: expect.stringMatching(/^arn:aws:lambda:us-east-1::runtime:/) });
    expect(() => synth('demo', { runtimeVersionArn: undefined })).toThrow(/runtime version/);
  });

  it('throwaway follows the runtime as Lambda updates it (no pin)', () => {
    for (const f of Object.values(synth('throwaway').findResources('AWS::Lambda::Function'))) expect((f as any).Properties.RuntimeManagementConfig).toBeUndefined();
  });
});
