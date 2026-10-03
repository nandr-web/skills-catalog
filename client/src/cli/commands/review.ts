// skills-catalog review [<name>]: the offline review run (contract §10, "on publish or offline"). Runs the catalog's
// reviewers over every stored version of a local catalog, or of one skill, stores each review that isn't current (another
// reviewer version, or none yet: a catalog from before reviews were kept) and re-indexes the cards, so search and read
// show them. Not an operation of the API: a person's command, like stats. A hosted catalog reviews each version as it is
// published, so it's refused there, opening nothing.
import { CatalogError, renderError, type ReviewRun, type Words } from '@skills-catalog/core';
import { Usage, type Command } from '../command.ts';

export const review: Command = {
  op: 'review',
  flags: {},
  input: (words) => {
    if (words.length > 1) throw new Usage();
    return words.length ? { name: words[0] } : {};
  },
  run: async ({ ctx, s, io, input, withActing }) => {
    if (!ctx.settings.catalog.startsWith('file:')) {
      io.stderr(withActing(s.format(s.word('review_run.hosted'))) + '\n');
      return 1;
    }
    try {
      const catalog = await ctx.catalog();
      io.stdout(withActing(renderReviewRun(s, await catalog.reviewStored(input as { name?: string }))) + '\n');
      return 0;
    } catch (e) {
      if (!(e instanceof CatalogError)) throw e;
      io.stderr(withActing(renderError(s, e)) + '\n');
      return 1;
    }
  },
};

/** What the run did, in the words (results.review_run). */
export function renderReviewRun(s: Words, r: ReviewRun): string {
  const w = (path: string, fields: Record<string, unknown> = {}) => s.format(s.word(`review_run.${path}`), fields);
  return [w('done', { versions: r.versions, reviewed: r.reviewed }), r.flagged.length ? w('flagged', { names: r.flagged.join(', ') }) : w('none_flagged')].join('\n');
}
