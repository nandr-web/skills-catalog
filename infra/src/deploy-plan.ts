// The deploy plan (slice 4, print-only): what a deploy of a preset makes, what it may cost, and every command in order,
// for the owner to read before the deploy go and then run by hand. It runs nothing and holds no secret: the GitHub app's
// secret is typed at a prompt, the origin secret is made in the shell, and neither is ever an argument or printed.

import { PRESETS, REGION, type PresetName } from './config.ts';
import { deployConfig, stackName } from './app.ts';

/** The CDK command line, pinned (the latest on npm on 2026-09-29); never a dependency of this package. */
export const CDK_CLI = 'npx --yes aws-cdk@2.1143.0';

export type PlanInput = { preset: PresetName; account: string; logins: string; clientId: string; alertEmail?: string; runtimeVersionArn?: string };

export function deployPlan(i: PlanInput): string {
  const config = deployConfig({ preset: i.preset, account: i.account, alertEmail: i.alertEmail, runtimeVersionArn: i.runtimeVersionArn });
  const p = PRESETS[i.preset];
  const stack = stackName(i.preset);
  const ctx = [`-c preset=${i.preset}`, `-c account=${i.account}`, ...(i.alertEmail ? [`-c alertEmail=${i.alertEmail}`] : []), ...(i.runtimeVersionArn ? [`-c runtimeVersionArn=${i.runtimeVersionArn}`] : [])].join(' ');
  const clientId = i.clientId || '<the GitHub app client id>';
  return `Deploy plan: the skills catalog, preset ${i.preset}, account ${i.account}, ${REGION}. Nothing below has run.

What it makes (stack ${stack}):
  - a CloudFront distribution with a web ACL (rate limit ${p.rateLimitPer5Min} requests per address in 5 minutes; sign-ins 10 a minute)
  - an HTTP API on Lambda (throttle ${p.throttle.rate}/s, burst ${p.throttle.burst}), an indexer and a sweep function, Node 24 on arm64
  - a DynamoDB table and a private S3 bucket for skills (${config.keepHistory ? 'point-in-time recovery and versioning on, kept if the stack is deleted' : 'deleted with the stack'})
  - an SQS FIFO queue with a dead-letter queue, alarms, and an SNS topic for alerts${config.alertEmail ? ` (emails ${config.alertEmail})` : ''}
What it may cost: not measured yet. A monthly budget of $${config.budgetUsd} alarms at 80% of actual spend${config.freePlan ? '; CloudFront is on its flat-rate Free plan' : ''}.

Run these by hand, in order, with AWS credentials for account ${i.account}:

1. Make a GitHub OAuth app (https://github.com/settings/applications/new), with "Enable Device Flow" ticked; any homepage
   and callback URL (the page isn't built). Note its client id; generate a client secret.

2. Store the app's secret (typed at the prompt, never on the command line):
   read -rs GH_SECRET && aws ssm put-parameter --region ${REGION} --type SecureString --name ${p.githubSecretParameter} --value "$GH_SECRET" && unset GH_SECRET

3. Make the origin secret CloudFront sends the API (its first value, version 1; rotating it comes with the runbook, not built yet):
   aws ssm put-parameter --region ${REGION} --type String --name ${p.originSecretParameters.current} --value "$(openssl rand -hex 32)"

4. Prepare the account for CDK (once per account and region):
   ${CDK_CLI} bootstrap aws://${i.account}/${REGION}

5. Deploy (from infra/, after npm ci --ignore-scripts here and in ../core and ../hosted):
   ${CDK_CLI} deploy ${stack} ${ctx} --parameters GitHubClientId=${clientId} --parameters SignInLogins=${i.logins}
   It prints CatalogUrl.

6. On each developer's machine (in client/, after npm ci --ignore-scripts):
   alias skills-catalog="node --disable-warning=ExperimentalWarning $PWD/src/cli.ts"
   export SKILLS_CATALOG=<CatalogUrl>
   skills-catalog login --client-id ${clientId}
   Then the assistant's tools and the CLI use the hosted catalog.

7. Or, without GitHub (CI, or before the app exists): a personal token, issued with these AWS credentials (in hosted/):
   TABLE=$(aws cloudformation describe-stack-resources --region ${REGION} --stack-name ${stack} --query "StackResources[?ResourceType=='AWS::DynamoDB::Table'].PhysicalResourceId" --output text)
   npm run issue-token -- --table "$TABLE" --owner <their github login> --days 30
   On their machine: export SKILLS_TOKEN=<the token>, or skills-catalog login --with-token < a file holding it.

8. Check it (in infra/): npm run smoke -- --url <CatalogUrl>, and with SKILLS_TOKEN set it publishes, finds, reads,
   fetches back and diffs a skill named smoke-<time>.

To delete it: ${CDK_CLI} destroy ${stack} ${ctx}${config.keepHistory ? ' (the table and bucket are kept: delete them by hand)' : ''}
`;
}
