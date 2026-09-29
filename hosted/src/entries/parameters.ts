// Reading a parameter's value from Parameter Store, decrypted. A parameter that was never set is no value (a first
// deploy has no previous origin value yet); any other failure (no permission, throttling) is thrown to the caller, whose
// rules decide (the origin guard keeps its last good values for a while; signing in answers internal_error).

import { GetParameterCommand, type SSMClient } from '@aws-sdk/client-ssm';

export function parameterReader(ssm: Pick<SSMClient, 'send'>): (name: string) => Promise<string | undefined> {
  return async (name) => {
    try {
      const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
      return r.Parameter?.Value;
    } catch (e) {
      if ((e as { name?: string }).name === 'ParameterNotFound') return undefined;
      throw e;
    }
  };
}
