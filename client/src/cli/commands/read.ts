// skills-catalog read <name>...: one skill, or several read together. --version reads an older one; --include, or its
// shorthands --files and --contents, says how much; --path, repeated, reads only those files of one skill (one path per
// flag, since a path may hold a comma). Reads only. Exit 1 when none of the names is found, 0 when at least one is.
import { contradicting, fromSchemaFlags, schemaFlags, Usage, type Command } from '../command.ts';

const own = schemaFlags('read_shared_skill', ['name', 'names', 'paths']);

export const read: Command = {
  op: 'read_shared_skill',
  readOnly: true,
  failsOn: ['none_found'],
  flags: { ...own, files: { type: 'boolean' }, contents: { type: 'boolean' }, path: { type: 'string', multiple: true } },
  input(words, values) {
    if (!words.length) throw new Usage();
    const args = fromSchemaFlags(own, values);
    if (words.length === 1) args['name'] = words[0];
    else args['names'] = [...words];
    for (const include of ['files', 'contents'] as const) {
      if (!values[include]) continue;
      if (args['include'] !== undefined && args['include'] !== include) throw contradicting('include');
      args['include'] = include;
    }
    if (values['path'] !== undefined) args['paths'] = values['path'];
    return args;
  },
};
