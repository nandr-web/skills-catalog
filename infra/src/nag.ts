// cdk-nag's AwsSolutions findings the stack answers rather than fixes, each with its reason, acknowledged on the
// construct it concerns (by its path under the stack; never the whole stack).

import { Validations, type Stack } from 'aws-cdk-lib';
import type { IConstruct } from 'constructs';
import type { PresetName } from './config.ts';

export type NagAnswer = { path: string; id: string; reason: string; presets?: PresetName[] };

export const NAG_ANSWERS: NagAnswer[] = [
  { path: 'Api/Http/DefaultRoute/Resource', id: 'AwsSolutions-APIG4', reason: 'No API Gateway authorizer: the handler checks the Bearer token itself, before any lookup (a missing or unknown one is refused), and the sign-in route has to be reachable without one since it is what issues it.' },
  { path: 'Api/Http/POST--api--v1--sign_in_with_github/Resource', id: 'AwsSolutions-APIG4', reason: 'The sign-in route is the one way to get a token, so it can\'t require one; it is throttled (0.6 a second, burst 5) and the firewall limits sign-ins per address.' },
  { path: 'Site/Edge/Resource', id: 'AwsSolutions-CFR1', reason: 'No geo restriction: the catalog\'s page is for developers wherever they are; nothing it serves is limited by country.' },
  { path: 'Site/Edge/Resource', id: 'AwsSolutions-CFR3', reason: 'No CloudFront access logs: the page is static and public, and a log bucket would hold visitors\' addresses for no use in a demo; every API call is in the API stage\'s own access log.' },
  { path: 'Site/Edge/Resource', id: 'AwsSolutions-CFR4', reason: 'The distribution uses CloudFront\'s default *.cloudfront.net certificate, whose TLS policy CloudFront sets; a custom domain (not in this release) would set TLSv1.2_2021.' },
  { path: 'Storage/Table/Resource', id: 'AwsSolutions-DDB3', reason: 'Point-in-time recovery is off on the throwaway preset only: its table lives for one smoke test and is deleted with the stack; the demo preset turns it on.', presets: ['throwaway'] },
  { path: 'Api/Role/DefaultPolicy/Resource', id: 'AwsSolutions-IAM5[Resource::<StorageFiles48C02C92.Arn>/blobs/*]', reason: 'Files are stored by their sha256 under blobs/, so their keys aren\'t known until a publish; the grant is limited to that prefix of the one files bucket.' },
  { path: 'Sweep/Role/DefaultPolicy/Resource', id: 'AwsSolutions-IAM5[Resource::<StorageFiles48C02C92.Arn>/blobs/*]', reason: 'Files are stored by their sha256 under blobs/, so their keys aren\'t known until a publish; the grant is limited to that prefix of the one files bucket.' },
  { path: 'Site/Pages/Resource', id: 'AwsSolutions-S1', reason: 'No server access logs on the pages bucket: it is private, read only by CloudFront through its origin access control, and holds only the static page.' },
  { path: 'Storage/Files/Resource', id: 'AwsSolutions-S1', reason: 'No server access logs on the files bucket: it is private (no public access, TLS only); every upload and download link is handed out by the API, whose stage access log records the call, and the catalog\'s events record each publish.' },
];

function find(stack: Stack, path: string): IConstruct {
  let c: IConstruct = stack;
  for (const part of path.split('/')) {
    const next = c.node.tryFindChild(part);
    if (!next) throw new Error(`cdk-nag answer for a construct that isn't there: ${path}`);
    c = next;
  }
  return c;
}

export function answerNag(stack: Stack, preset: PresetName): void {
  for (const a of NAG_ANSWERS) if (!a.presets || a.presets.includes(preset)) Validations.of(find(stack, a.path)).acknowledge({ id: a.id, reason: a.reason });
}
