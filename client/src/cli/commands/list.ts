// skills-catalog list: the skills installed from the catalog, and which are behind. Reads only.
import { exactly, type Command } from '../command.ts';

export const list: Command = {
  op: 'list_installed_skills',
  readOnly: true,
  flags: {},
  input: (words) => exactly(words, []),
};
