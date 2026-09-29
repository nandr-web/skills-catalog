// skills-catalog policy <auto|notify|pin> [<name>]: the default for updates, or one installed skill's.
import { Usage, type Command } from '../command.ts';

export const policy: Command = {
  op: 'set_skill_update_policy',
  flags: {},
  input(words) {
    if (words.length < 1 || words.length > 2) throw new Usage();
    return words.length === 1 ? { policy: words[0] } : { policy: words[0], name: words[1] };
  },
};
