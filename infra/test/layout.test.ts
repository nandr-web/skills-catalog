// The stack names the hosted catalog's places the way its adapters do: skill files under the same prefix (the create-only
// policy and the sweep's one delete), the same search file (the indexer's writes, the API's reads), the same events
// partition (the pipe's filter) and the same origin header. One side changing alone fails here.

import { describe, expect, it } from 'vitest';
import { ORIGIN_HEADER as HOSTED_ORIGIN_HEADER } from '../../hosted/src/api/origin.ts';
import { BLOB_PREFIX as HOSTED_BLOB_PREFIX, EVENTS_PK as HOSTED_EVENTS_PK, SEARCH_KEY as HOSTED_SEARCH_KEY } from '../../hosted/src/place.ts';
import { EVENTS_PK } from '../src/constructs/events.ts';
import { SEARCH_KEY } from '../src/constructs/functions.ts';
import { ORIGIN_HEADER } from '../src/constructs/site.ts';
import { BLOB_PREFIX } from '../src/constructs/storage.ts';

describe("the stack's names for the catalog's places are the adapters'", () => {
  it('skill files, the search file, the events partition and the origin header', () => {
    expect([BLOB_PREFIX, SEARCH_KEY, EVENTS_PK, ORIGIN_HEADER]).toEqual([HOSTED_BLOB_PREFIX, HOSTED_SEARCH_KEY, HOSTED_EVENTS_PK, HOSTED_ORIGIN_HEADER]);
  });
});
