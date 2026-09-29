// npm run deploy-plan -- --preset throwaway --account 123456789012 --logins ana,bob [--client-id …] [--alert-email …]
// Prints the deploy plan (src/deploy-plan.ts). Runs nothing.
import { parseArgs } from 'node:util';
import { deployPlan } from '../src/deploy-plan.ts';

const { values } = parseArgs({
  options: { preset: { type: 'string', default: 'throwaway' }, account: { type: 'string' }, logins: { type: 'string', default: '' }, 'client-id': { type: 'string', default: '' }, 'alert-email': { type: 'string' }, 'runtime-version-arn': { type: 'string' } },
});
try {
  process.stdout.write(
    deployPlan({
      preset: values.preset as 'throwaway' | 'demo',
      account: values.account ?? '',
      logins: values.logins,
      clientId: values['client-id'],
      ...(values['alert-email'] ? { alertEmail: values['alert-email'] } : {}),
      ...(values['runtime-version-arn'] ? { runtimeVersionArn: values['runtime-version-arn'] } : {}),
    }),
  );
} catch (e) {
  process.stderr.write(`deploy-plan: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
