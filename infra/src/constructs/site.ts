// The site and the edge (the web build notes): one CloudFront distribution in front of a private site bucket (by origin
// access control) and the HTTP API at /api/* (never cached, the viewer's headers passed on, so the page and the API are
// one origin and need no CORS), behind a web ACL. Every setting stays within CloudFront's flat-rate Free plan: ≤ 5 WAF
// rules from managed groups or a rate limit, ≤ 5 cache behaviors, managed policies only; the page's deep links and its
// security headers (the local page's own, its CSP among them) by CloudFront functions on its own behavior. CloudFront
// sends the origin secret to the API as a header (its value a reference to the parameter's version), so a request that
// skips the edge is refused.

import { Fn, type RemovalPolicy } from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { AllowedMethods, CachePolicy, Distribution, Function as EdgeFunction, FunctionCode, FunctionEventType, FunctionRuntime, OriginRequestPolicy, ResponseHeadersPolicy, ViewerProtocolPolicy } from 'aws-cdk-lib/aws-cloudfront';
import { HttpOrigin, S3BucketOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { CfnWebACL } from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { SECURITY_HEADERS } from '../../../core/src/http/index.ts';
import { SIGN_IN_PATH } from './functions.ts';

export { SIGN_IN_PATH };

/** The header CloudFront adds on the way to the API; the API refuses a request without the right value. */
export const ORIGIN_HEADER = 'x-skills-catalog-origin';

// The page's security headers, the same ones the local page's server sends (core/http), added to each of its answers.
const PAGE_HEADERS = `function handler(event) {
  var response = event.response;
  var add = ${JSON.stringify(Object.fromEntries(Object.entries(SECURITY_HEADERS).map(([k, v]) => [k, { value: v }])))};
  for (var name in add) response.headers[name] = add[name];
  return response;
}`;

// The page's own routes (deep links) are paths whose last part has no extension: they get the page. Custom error
// responses would do it for the whole distribution and turn the API's 403 and 404 into the page, so a function does it
// on the page's behavior only.
const DEEP_LINKS = `function handler(event) {
  var request = event.request;
  var last = request.uri.split('/').pop();
  if (request.uri !== '/' && !/\\.[A-Za-z0-9]+$/.test(last)) request.uri = '/index.html';
  return request;
}`;

export type SiteProps = { api: HttpApi; originSecret: { parameter: string; version: number }; removal: RemovalPolicy; rateLimitPer5Min: number };

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
        {
          // Signing in takes no token and spends our app's GitHub allowance: 10 a minute from one address (WAF's
          // smallest limit and window), on its exact path.
          name: 'SignInPerAddress',
          priority: 5,
          statement: {
            rateBasedStatement: {
              limit: 10,
              evaluationWindowSec: 60,
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: { searchString: SIGN_IN_PATH, fieldToMatch: { uriPath: {} }, positionalConstraint: 'EXACTLY', textTransformations: [{ priority: 0, type: 'NONE' }] },
              },
            },
          },
          action: { block: {} },
          visibilityConfig: { sampledRequestsEnabled: true, cloudWatchMetricsEnabled: true, metricName: 'SignInPerAddress' },
        },
      ],
    });

    // The API's own host, from its endpoint (https://<id>.execute-api.<region>.amazonaws.com).
    const apiHost = Fn.select(2, Fn.split('/', p.api.apiEndpoint));
    const deepLinks = new EdgeFunction(this, 'DeepLinks', { code: FunctionCode.fromInline(DEEP_LINKS), runtime: FunctionRuntime.JS_2_0 });
    const pageHeaders = new EdgeFunction(this, 'PageHeaders', { code: FunctionCode.fromInline(PAGE_HEADERS), runtime: FunctionRuntime.JS_2_0 });
    this.distribution = new Distribution(this, 'Edge', {
      defaultRootObject: 'index.html',
      webAclId: this.webAcl.attrArn,
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          { function: deepLinks, eventType: FunctionEventType.VIEWER_REQUEST },
          { function: pageHeaders, eventType: FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      additionalBehaviors: {
        '/api/*': {
          // By version: a rotation's new version changes the distribution, so the deploy sends CloudFront the new value.
          origin: new HttpOrigin(apiHost, { customHeaders: { [ORIGIN_HEADER]: `{{resolve:ssm:${p.originSecret.parameter}:${p.originSecret.version}}}` } }),
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
