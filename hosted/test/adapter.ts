// The hosted adapters as a test adapter for the core's shared suites: each store is a fresh table and bucket on the
// stand-in. A catalog's publish goes the hosted way, as a caller makes it: request_upload_links, each file through its
// link (a presigned PUT), then publish_version names the files by sha256. The store's readers go to DynamoDB and S3
// directly, never through the adapters.

import { createHash } from 'node:crypto';
import { DynamoDBClient, ScanCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { Catalog, MAX_UPLOAD_LINKS, actAs, type Identity, type Storage } from '@skills-catalog/core';
import { counterIds, fixedClock, type StoreOptions, type TestAdapter, type TestStore } from '@skills-catalog/core/testing/suites';
import { createStores, HostedBlobLinks, HostedEvents, HostedFileNames, HostedStorage, HostedTokenStore, S3SearchIndex, BLOB_PREFIX, namesClient, type Place } from '../src/index.ts';
import { FAKE } from './emulator.ts';

let stores = 0;

/** The storage suite's own commits (it drives the Storage port directly, with bytes, as the local adapter takes them):
 *  each file not yet stored goes up through its link, then the commit names them all by sha256 (the hosted commit takes
 *  no bytes). A catalog's commits already come by sha256 alone, so this passes them through. */
function uploading(storage: Storage, links: HostedBlobLinks): Storage {
  return Object.assign(Object.create(storage), {
    commit: async (...[v, files, cond, event]: Parameters<Storage['commit']>) => {
      // Each file once (a skill can hold the same bytes twice), and only those given with their bytes.
      const toSend = [...new Map(files.filter((f) => f.bytes !== undefined).map((f) => [f.sha256, f.bytes!])).entries()];
      const answers = toSend.length ? await links.uploadLinks(toSend.map(([sha256, bytes]) => ({ sha256, size: bytes.length }))) : [];
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

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
export type InlineRequest = { name: string; files: { path: string; mode: string; content_base64: string }[] } & Record<string, unknown>;
export const isInline = (x: unknown): x is InlineRequest => {
  const r = x as InlineRequest;
  return typeof r === 'object' && r !== null && typeof r.name === 'string' && Array.isArray(r.files) && r.files.length > 0 &&
    r.files.every((f) => typeof f === 'object' && f !== null && typeof f.content_base64 === 'string' && BASE64.test(f.content_base64) && !('sha256' in f));
};

/** A caller's side of a hosted publish, from an inline request: each distinct file's sha256 and size to
 *  request_upload_links, a PUT through each link it gives, then the same request naming every file by sha256. */
export async function toUploaded(catalog: Catalog, input: InlineRequest, identity?: Identity): Promise<Record<string, unknown>> {
  const files = input.files.map((f) => {
    const bytes = Buffer.from(f.content_base64, 'base64');
    return { path: f.path, mode: f.mode, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const distinct = [...new Map(files.map((f) => [f.sha256, f.bytes])).entries()];
  // At most MAX_UPLOAD_LINKS files a request, as a caller asks for them.
  for (let at = 0; at < distinct.length; at += MAX_UPLOAD_LINKS) {
    const batch = distinct.slice(at, at + MAX_UPLOAD_LINKS);
    const links = await catalog.uploadLinks({ name: input.name, files: batch.map(([sha256, bytes]) => ({ sha256, size: bytes.length })) }, identity);
    for (const [i, a] of links.files.entries()) {
      if (a.kind !== 'upload') continue;
      const r = await fetch(a.url, { method: 'PUT', body: batch[i]![1], headers: a.headers });
      // 412: another publish put the same file between the link and this upload (put-if-absent); the commit checks its
      // bytes either way.
      if (!r.ok && r.status !== 412) throw new Error(`upload of ${a.sha256} answered ${r.status}`);
    }
  }
  return { ...input, files: files.map(({ path, mode, sha256 }) => ({ path, mode, sha256 })) };
}

/** The same caller for the shared suites, which publish inline as a local caller does. A request that isn't inline goes
 *  to the catalog as it is, so its refusals are the catalog's own. A fetch's links are followed back to bytes, so the
 *  suites read what they published. */
function hostedCaller(catalog: Catalog): Catalog {
  return Object.assign(Object.create(catalog), {
    publish: async (...[input, identity, face]: Parameters<Catalog['publish']>) =>
      catalog.publish(isInline(input) ? await toUploaded(catalog, input, identity) : input, identity, face),
    fetch: async (...args: Parameters<Catalog['fetch']>) => {
      const r = await catalog.fetch(...args);
      const files = await Promise.all(
        r.files.map(async (f) => {
          if (!('url' in f)) return f;
          const got = await fetch(f.url);
          if (!got.ok) throw new Error(`download of ${f.sha256} answered ${got.status}`);
          return { path: f.path, mode: f.mode, content_base64: Buffer.from(await got.arrayBuffer()).toString('base64') };
        }),
      );
      return { ...r, files };
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
          const catalog = await Catalog.open({
            where: 'hosted',
            links,
            tokens: new HostedTokenStore({ ddb, place, clock }),
            // GitHub is never asked here: its own tests (github.test.ts) use a stand-in of GitHub.
            signIn: { login: async () => undefined },
            storage: uploading(naming(wrapStorage ? wrapStorage(storage) : storage, new HostedFileNames({ ddb: indexer, place })), links),
            index: new S3SearchIndex({ s3, place }),
            events: new HostedEvents({ ddb, place }),
            identity: opts.identity ?? actAs(undefined),
            clock,
            ids: opts.ids ?? counterIds(),
            ...(opts.config ? { config: opts.config } : {}),
            ...(opts.reviewers ? { reviewers: opts.reviewers } : {}),
            close: () => {
              ddb.destroy();
              indexer.destroy();
              s3.destroy();
            },
          });
          return hostedCaller(catalog);
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
          // Every item but the events' delivery marks, and every object with its bytes' sha256, in a stable order. A file
          // no item names is left out: a refused publish's uploads stay unreferenced until the sweep (contract §1.1),
          // since a caller uploads before the catalog's checks, so "storage as it was" is what the records reach.
          const items = ((await readers.ddb.send(new ScanCommand({ TableName: place.table }))).Items ?? []).map((i) => {
            const { delivered: _, ...rest } = i;
            return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))));
          });
          const objects: string[] = [];
          const listed = await readers.s3.send(new ListObjectsV2Command({ Bucket: place.bucket }));
          const named = new Set(items.flatMap((i) => i.match(/[0-9a-f]{64}/g) ?? []));
          for (const o of listed.Contents ?? []) {
            if (o.Key!.startsWith(BLOB_PREFIX) && !named.has(o.Key!.slice(BLOB_PREFIX.length))) continue;
            const body = await readers.s3.send(new GetObjectCommand({ Bucket: place.bucket, Key: o.Key! }));
            objects.push(`${o.Key} ${createHash('sha256').update(await body.Body!.transformToByteArray()).digest('hex')}`);
          }
          return [...items.sort(), '---', ...objects.sort()].join('\n');
        },
      };
    },
  };
}
