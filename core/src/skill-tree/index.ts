// The shared skill-tree module: what a skill's files must be, how they're identified, and what changed between two
// versions. The catalog core and the installer both import it (`@skills-catalog/core/skill-tree`), so both sides agree
// on every rule. It depends on nothing else in the core.

export * from './errors.ts';
export * from './tree.ts';
export * from './manifest.ts';
export * from './diff.ts';
export * from './secrets.ts';
