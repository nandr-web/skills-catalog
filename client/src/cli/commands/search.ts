// skills-catalog search <words>: the catalog's search. The words are the query (none lists the catalog); --tags a,b,
// --publisher and --updated-since are its filters, --limit and --cursor its paging. Reads only.
import { fromSchemaFlags, listOf, schemaFlags, type Command } from '../command.ts';

const own = schemaFlags('search_shared_skills', ['query', 'filters']);

export const search: Command = {
  op: 'search_shared_skills',
  readOnly: true,
  flags: { ...own, tags: { type: 'string' }, publisher: { type: 'string' }, 'updated-since': { type: 'string' } },
  input(words, values) {
    const args = fromSchemaFlags(own, values);
    if (words.length) args['query'] = words.join(' ');
    const filters: Record<string, unknown> = {};
    if (typeof values['tags'] === 'string') filters['tags'] = listOf(values['tags']);
    if (values['publisher'] !== undefined) filters['publisher'] = values['publisher'];
    if (values['updated-since'] !== undefined) filters['updated_since'] = values['updated-since'];
    if (Object.keys(filters).length) args['filters'] = filters;
    return args;
  },
};
