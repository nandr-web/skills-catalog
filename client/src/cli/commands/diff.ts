// skills-catalog diff <name> --from <n> --to <n>: what changed between two versions. Reads only.
import { exactly, fromSchemaFlags, schemaFlags, type Command } from '../command.ts';

const own = schemaFlags('diff_shared_skill_versions', ['name']);

export const diff: Command = {
  op: 'diff_shared_skill_versions',
  readOnly: true,
  flags: own,
  input: (words, values) => ({ ...exactly(words, ['name']), ...fromSchemaFlags(own, values) }),
};
