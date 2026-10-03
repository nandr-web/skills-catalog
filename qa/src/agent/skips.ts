// Which scenarios the runner can start today, and why not the others: shared by the runner (it skips them, saying why)
// and trace-check (a check of a skipped scenario can't be marked automated; review P3.2, P11.3).

/** The starting catalogs the runner can seed. */
export const SERVED = new Set(['queries.corpus']);

/** Why the runner skips a scenario, or undefined when it runs it. */
export function skipReason(s: { catalog?: unknown; workdir_fixtures?: unknown; installed?: unknown; before?: unknown }): string | undefined {
  const catalogs = [s.catalog].flat().map(String);
  const unserved = catalogs.filter((c) => !SERVED.has(c));
  if (unserved.length) return `starting catalog ${unserved.join(', ')} needs the catalog's publish to seed it (slice 1)`;
  if (s.workdir_fixtures || s.installed || s.before) return 'starting files need the fixture builder (slice 1)';
  return undefined;
}
