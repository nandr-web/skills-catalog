// What `cdk` starts (cdk.json): the stack for the preset and account in its context, e.g.
//   npx aws-cdk@<version> deploy -c preset=throwaway -c account=123456789012
// Run only at the owner's deploy go; `npm run deploy-plan` prints the whole sequence first.
import { App } from 'aws-cdk-lib';
import { buildApp } from '../src/app.ts';
import { CATALOG_CODE } from '../src/code.ts';

const app = new App();
const ctx = (k: string) => app.node.tryGetContext(k) as string | undefined;
buildApp(
  {
    preset: (ctx('preset') ?? 'throwaway') as 'throwaway' | 'demo',
    account: ctx('account') ?? process.env['CDK_DEFAULT_ACCOUNT'],
    alertEmail: ctx('alertEmail'),
    runtimeVersionArn: ctx('runtimeVersionArn'),
    originSecretVersion: ctx('originSecretVersion') ? Number(ctx('originSecretVersion')) : undefined,
  },
  CATALOG_CODE,
  app,
);
app.synth();
