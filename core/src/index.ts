// The core's public face: the catalog operations, the API, the words, and the local adapters.

export * from './catalog.ts';
export * from './errors.ts';
export * from './ports.ts';
export * from './api.ts';
export { openCatalog } from './open.ts';
export { openRemoteCatalog, type RemoteOptions } from './remote/index.ts';
export { actAs, openLocalCatalog, randomIds, type LocalOptions } from './local/index.ts';
export { memorySearchIndex } from './local/search-index.ts';
export { Words } from './words-file.ts';
export * from './render.ts';
export { toCatalogError } from './internal-error.ts';
