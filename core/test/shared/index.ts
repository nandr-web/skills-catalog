// The suites every storage adapter runs, for another package's adapters (the hosted ones) to run on theirs.
export { storageSuite } from './storage.ts';
export { catalogSuite } from './catalog.ts';
export { reviewsSuite } from './reviews.ts';
export { discoverySuite } from './discovery.ts';
export type { StoreOptions, TestAdapter, TestStore } from '../adapters.ts';
export { counterIds, fixedClock } from '../helpers.ts';
