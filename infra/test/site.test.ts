// The site and the edge (the web build notes): one CloudFront distribution in front of a private site bucket (by
// origin access control) and the HTTP API (/api/*, never cached, same origin so no CORS), behind a web ACL. Its settings
// stay within what CloudFront's flat-rate Free plan allows, in both presets: ≤ 5 WAF rules and no custom rule groups,
// ≤ 5 cache behaviors, managed cache, origin-request and response-header policies only, no legacy forwarded values, no
// origin access identity. Demo subscribes the distribution and its web ACL to the Free plan and pins the functions'
// exact runtime version; throwaway pays as it goes. Demo has a budget alarm.

import { Match, type Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { PRESETS, REGION } from '../src/config.ts';
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

    it('managed policies only, no legacy forwarded values', () => {
      for (const type of ['AWS::CloudFront::CachePolicy', 'AWS::CloudFront::OriginRequestPolicy', 'AWS::CloudFront::ResponseHeadersPolicy']) t.resourceCountIs(type, 0);
      expect(JSON.stringify(distribution(t))).not.toContain('ForwardedValues');
    });

    it("deep links: a CloudFront function on the default behavior's viewer request sends a path without an extension to /index.html; never custom error responses (they'd turn the API's 403 and 404 into the page)", () => {
      const d = distribution(t);
      expect(d.CustomErrorResponses).toBeUndefined();
      const onRequest = (d.DefaultCacheBehavior.FunctionAssociations ?? []).filter((a: { EventType: string }) => a.EventType === 'viewer-request');
      expect(onRequest.length).toBe(1);
      for (const b of d.CacheBehaviors) expect(b.FunctionAssociations, b.PathPattern).toBeUndefined();
      const fns = Object.values(t.findResources('AWS::CloudFront::Function')) as { Properties: { FunctionCode: string; FunctionConfig: { Runtime: string } } }[];
      const code = fns.map((f) => f.Properties.FunctionCode).find((c) => c.includes('index.html'))!;
      // The function's own code, run as CloudFront runs it: handler(event) → the request.
      const handler = new Function(`${code}; return handler;`)() as (e: unknown) => { uri: string };
      const uri = (u: string) => handler({ request: { uri: u, headers: {} } }).uri;
      expect(uri('/skills/pr-review')).toBe('/index.html');
      expect(uri('/bundles/team/')).toBe('/index.html');
      expect(uri('/assets/app.3f2a.js')).toBe('/assets/app.3f2a.js');
      expect(uri('/favicon.svg')).toBe('/favicon.svg');
      expect(uri('/')).toBe('/');
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

describe('where it runs, and who hears the alarms', () => {
  it("the region is us-east-1: a web ACL for CloudFront can only be made there, and it's in this stack", () => {
    expect(REGION).toBe('us-east-1');
    for (const preset of ['throwaway', 'demo'] as const) expect(PRESETS[preset].env.region).toBe('us-east-1');
    synth('throwaway').hasResourceProperties('AWS::WAFv2::WebACL', { Scope: 'CLOUDFRONT' });
  });

  it('the alerts topic has an email subscriber when an address is given at the deploy go; none in code', () => {
    const given = synth('throwaway', { alertEmail: 'alerts@example.test' });
    given.hasResourceProperties('AWS::SNS::Subscription', { Protocol: 'email', Endpoint: 'alerts@example.test' });
    synth('throwaway').resourceCountIs('AWS::SNS::Subscription', 0);
    for (const preset of ['throwaway', 'demo'] as const) expect(PRESETS[preset].alertEmail).toBeUndefined();
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

  it('a budget alarm, and a small one for throwaway too (a forgotten throwaway stack is the likeliest surprise bill)', () => {
    for (const [preset, usd] of [['demo', 10], ['throwaway', 5]] as const) {
      synth(preset).resourceCountIs('AWS::Budgets::Budget', 1);
      synth(preset).hasResourceProperties('AWS::Budgets::Budget', { Budget: { BudgetLimit: { Amount: usd, Unit: 'USD' } } });
    }
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
