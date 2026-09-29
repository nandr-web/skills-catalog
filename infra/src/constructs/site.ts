// The site and the edge (the web build notes): one CloudFront distribution in front of a private site bucket (by
// origin access control) and the HTTP API at /api/* (never cached, the viewer's headers passed on, so the page and the
// API are one origin and need no CORS), behind a web ACL. Every setting stays within CloudFront's flat-rate Free plan:
// ≤ 5 WAF rules from managed groups or a rate limit, ≤ 5 cache behaviors, managed policies only. CloudFront sends the
// origin secret to the API as a header (its value a parameter reference), so a request that skips the edge is refused.

import { Fn, type RemovalPolicy } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { AllowedMethods, CachePolicy, Distribution, OriginRequestPolicy, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';

/** The header CloudFront adds on the way to the API; the API refuses a request without the right value. */
export const ORIGIN_HEADER = 'x-skills-catalog-origin';

export type SiteProps = { api: HttpApi; originSecretParameter: string; removal: RemovalPolicy; rateLimitPer5Min: number };

const managed = (name: string, priority: number, overrides: string[] = []): CfnWebACL.RuleProperty => ({
  name,
  priority,
  statement: { managedRuleGroupStatement: { vendorName: 'AWS', name, ruleActionOverrides: overrides.map((o) => ({ name: o, actionToUse: { count: {} } })) } },
  overrideAction: { none: {} },
  visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: name },
});

export class Site extends Construct {
  readonly bucket: Bucket;
  readonly distribution: Distribution;
  readonly webAcl: CfnWebACL;

  constructor(scope: Construct, id: string, p: SiteProps) {
    super(scope, id);
    this.bucket = new Bucket(this, 'Pages', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: p.removal,
      autoDeleteObjects: p.removal === 'destroy',
    });

    this.webAcl = new CfnWebACL(this, 'Firewall', {
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'skills-catalog' },
      rules: [
        // The common set's body size rule stops at 8 KB; a publish is bigger, and its limits are the catalog's own.
        managed('AWSManagedRulesCommonRuleSet', 1, ['SizeRestrictions_BODY']),
        managed('AWSManagedRulesKnownBadInputsRuleSet', 2),
        managed('AWSManagedRulesAmazonIpReputationList', 3),
        {
          name: 'RatePerAddress',
          priority: 4,
          statement: { rateBasedStatement: { limit: p.rateLimitPer5Min, aggregateKeyType: 'IP' } },
          action: { block: {} },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'RatePerAddress' },
        },
      ],
    });

    // The API's own host, from its endpoint (https://<id>.execute-api.<region>.amazonaws.com).
    const apiHost = Fn.select(2, Fn.split('/', p.api.apiEndpoint));
    this.distribution = new Distribution(this, 'Edge', {
      defaultRootObject: 'index.html',
      webAclId: this.webAcl.attrArn,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new HttpOrigin(apiHost, { customHeaders: { [ORIGIN_HEADER]: `{{resolve:ssm:${p.originSecretParameter}}}` } }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_ALL,
          cachePolicy: CachePolicy.CACHING_DISABLED,
          originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
    });
  }
}
