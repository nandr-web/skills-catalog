// The hosted adapters as a test adapter for the core's shared suites: each store is a fresh table and bucket on the
// stand-in. A catalog's publish goes the hosted way: each file through an upload link (a presigned PUT), then the
// commit names the files by sha256. The store's readers go to DynamoDB and S3 directly, never through the adapters.

import { createHash } from 'node:crypto';
import { DynamoDBClient, ScanCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Catalog, actAs, type Storage } from '@skills-catalog/core';
import { counterIds, fixedClock, type StoreOptions, type TestAdapter, type TestStore } from '@skills-catalog/core/testing/suites';
import { createStores, HostedBlobLinks, HostedEvents, HostedFileNames, HostedStorage, S3SearchIndex, BLOB_PREFIX, namesClient, type Place } from '../src/index.ts';
import { FAKE } from './emulator.ts';

let stores = 0;

/** The catalog's publish, the hosted way: each file not yet stored goes up through its link, then the commit names them
 *  all by sha256 (the hosted commit takes no bytes). */
function uploading(storage: Storage, links: HostedBlobLinks): Storage {
  return Object.assign(Object.create(storage), {
    commit: async (...[v, files, cond, event]: Parameters<Storage['commit']>) => {
      // Each file once (a skill can hold the same bytes twice), and only those given with their bytes.
      const toSend = [...new Map(files.filter((f) => f.bytes !== undefined).map((f) => [f.sha256, f.bytes!])).entries()];
      const answers = await links.uploadLinks(toSend.map(([sha256, bytes]) => ({ sha256, size: bytes.length })));
      for (const [i, a] of answers.entries()) {
        if (a.kind !== 'upload') continue;
        const r = await fetch(a.url, { method: 'PUT', body: Buffer.from(toSend[i]![1]), headers: a.headers });
        // 412: another publish put the same file between the link and this upload (put-if-absent); the commit checks
        // its bytes either way.
        if (!r.ok && r.status !== 412) throw new Error(`upload of ${a.sha256} answered ${r.status}`);
      }
      return storage.commit(v, files.map((f) => ({ sha256: f.sha256 })), cond, event);
    },
  });
}

/** The names indexer, run as soon as a commit creates a version (in AWS it trails the publish by seconds), so a file a
 *  stored version names is named, as the shared suites expect; on its way is hosted's own tests' to drive. */
function naming(storage: Storage, names: HostedFileNames): Storage {
  return Object.assign(Object.create(storage), {
    commit: async (...args: Parameters<Storage['commit']>) => {
      const r = await storage.commit(...args);
      if (r.kind === 'created') await names.record(r.record);
      return r;
    },
  });
}

export function hostedAdapter(endpoint: () => string): TestAdapter {
  const clients = () => ({
    ddb: new DynamoDBClient({ ...FAKE, endpoint: endpoint() }),
    s3: new S3Client({ ...FAKE, endpoint: endpoint(), forcePathStyle: true, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }),
  });
  return {
    name: 'hosted',
    takesBackRefusedFiles: false,
    hasOnItsWay: true,
    store(): TestStore {
      const n = ++stores;
      const place: Place = { table: `skills-${n}`, bucket: `skills-catalog-${n}` };
      let made: Promise<void> | undefined;
      const readers = clients();
      const ready = () => (made ??= createStores(readers.ddb, readers.s3, place));
      return {
        async open({ failNextAppend, wrapStorage, ...opts }: StoreOptions = {}) {
          await ready();
          const { ddb, s3 } = clients();
          if (failNextAppend) {
            // The commit's one transaction fails once, after the files were uploaded.
            const send = ddb.send.bind(ddb);
            let fail: Error | undefined = failNextAppend;
            ddb.send = ((cmd: unknown, ...rest: unknown[]) => {
              if (fail && cmd instanceof TransactWriteItemsCommand) {
                const e = fail;
                fail = undefined;
                return Promise.reject(e);
              }
              return (send as (...a: unknown[]) => unknown)(cmd, ...rest);
            }) as typeof ddb.send;
          }
          const clock = opts.clock ?? fixedClock();
          const storage = new HostedStorage({ ddb, s3, place, clock });
          const links = new HostedBlobLinks({ s3, place, clock });
          const indexer = namesClient({ ...FAKE, endpoint: endpoint() });
          return Catalog.open({
            where: 'hosted',
            links,
            storage: uploading(naming(wrapStorage ? wrapStorage(storage) : storage, new HostedFileNames({ ddb: indexer, place })), links),
            index: new S3SearchIndex({ s3, place }),
            events: new HostedEvents({ ddb, place }),
            identity: opts.identity ?? actAs(undefined),
            clock,
            ids: opts.ids ?? counterIds(),
            ...(opts.config ? { config: opts.config } : {}),
            close: () => {
              ddb.destroy();
              indexer.destroy();
              s3.destroy();
            },
          });
        },
        async blobs() {
          await ready();
          const out = new Set<string>();
          let token: string | undefined;
          do {
            const page = await readers.s3.send(new ListObjectsV2Command({ Bucket: place.bucket, Prefix: BLOB_PREFIX, ContinuationToken: token }));
            for (const o of page.Contents ?? []) out.add(o.Key!.slice(BLOB_PREFIX.length));
            token = page.NextContinuationToken;
          } while (token);
          return out;
        },
        async versionsIn(name) {
          await ready();
          const items = (await readers.ddb.send(new ScanCommand({ TableName: place.table }))).Items ?? [];
          return items.filter((i) => i['pk']?.S === `v#${name}`).map((i) => Number(i['sk']!.S)).sort((a, b) => a - b);
        },
        async snapshot() {
          await ready();
          // Every item but the events' delivery marks, and every object with its bytes' sha256, in a stable order.
          const items = ((await readers.ddb.send(new ScanCommand({ TableName: place.table }))).Items ?? []).map((i) => {
            const { delivered: _, ...rest } = i;
            return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))));
          });
          const objects: string[] = [];
          const listed = await readers.s3.send(new ListObjectsV2Command({ Bucket: place.bucket }));
          for (const o of listed.Contents ?? []) {
            const body = await readers.s3.send(new GetObjectCommand({ Bucket: place.bucket, Key: o.Key! }));
            objects.push(`${o.Key} ${createHash('sha256').update(await body.Body!.transformToByteArray()).digest('hex')}`);
          }
          return [...items.sort(), '---', ...objects.sort()].join('\n');
        },
      };
    },
  };
}
