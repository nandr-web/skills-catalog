// The core's public face: the catalog operations, the registry, the words, and the local adapters.

export * from './catalog.ts';
export * from './errors.ts';
export * from './ports.ts';
export * from './registry.ts';
export { openCatalog } from './open.ts';
export { actAs, openLocalCatalog, type LocalOptions } from './local/index.ts';
export { Surface } from './surface.ts';
export * from './render.ts';
export { toCatalogError } from './internal-error.ts';
