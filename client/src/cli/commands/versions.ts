// skills-catalog versions <name>: a skill's history, newest first; --cursor for older ones. Reads only.
import { exactly, fromSchemaFlags, schemaFlags, type Command } from '../command.ts';

const own = schemaFlags('list_shared_skill_versions', ['name']);

export const versions: Command = {
  op: 'list_shared_skill_versions',
  readOnly: true,
  flags: own,
  input: (words, values) => ({ ...exactly(words, ['name']), ...fromSchemaFlags(own, values) }),
};
