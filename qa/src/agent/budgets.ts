// A scenario's budgets (qa-plan.md §7), from golden/agent-scenarios.yaml: defaults.budgets, then the scenario's own.
// `gate` says when a miss fails a run: "always", or "when_feature_complete" (reported, never failing, until the gate is
// set to "always": the plan's "Budgets are reported now and must pass once the catalog is feature-complete").
import type { Budgets } from './score.ts';

export function budgetsOf(doc: { defaults?: { budgets?: Record<string, unknown> } }, scenario: { budgets?: Record<string, unknown> }): Budgets {
  const { gate, ...budgets } = { ...(doc.defaults?.budgets ?? {}), ...(scenario.budgets ?? {}) } as Budgets & { gate?: string };
  return { ...budgets, enforce: gate === undefined || gate === 'always' };
}
