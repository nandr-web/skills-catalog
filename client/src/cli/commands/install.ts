// skills-catalog install <name>: --version, --target user|project (--project for short, as the companion skill says),
// and --policy, the CLI's own input (setting a policy isn't something install's tool may do).
import { contradicting, exactly, fromSchemaFlags, schemaFlags, type Command } from '../command.ts';

const own = schemaFlags('install_shared_skill', ['name']);

export const install: Command = {
  op: 'install_shared_skill',
  flags: { ...own, project: { type: 'boolean' } },
  input(words, values) {
    const args = { ...exactly(words, ['name']), ...fromSchemaFlags(own, values) };
    if (values['project']) {
      if (args['target'] !== undefined && args['target'] !== 'project') throw contradicting('target');
      args['target'] = 'project';
    }
    return args;
  },
};
