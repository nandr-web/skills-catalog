// The shared skill-tree module: what a skill's files must be, how they're identified, and what changed between two
// versions. The catalog core and the installer both import it, so both sides agree on every rule.

export * from './tree.ts';
export * from './manifest.ts';
export * from './diff.ts';
