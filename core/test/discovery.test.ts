// The discovery golden set on every adapter (test/shared/discovery.ts).

import { ADAPTERS } from './adapters.ts';
import { discoverySuite } from './shared/discovery.ts';

for (const a of ADAPTERS) discoverySuite(a);
