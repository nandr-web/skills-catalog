// Storage across processes (golden/histories.yaml `concurrent`): many processes publishing one name, or opening one
// fresh catalog, at the same moment. Each process is started, says it is ready once its imports are loaded, and only
// then are all of them given one start time a moment ahead, so their work overlaps however busy the machine is.
// They start 320 processes, so they run with `npm run test:slow` (listed in test/slow.json), not with `npm test`.

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inlineFiles } from '../src/catalog.ts';
import { openLocalCatalog } from '../src/local/index.ts';
import { processEnv } from './process-env.ts';
import { sandbox } from './sandbox.ts';

/** How far ahead of "every process is ready" the shared start is: time for each one to read it. */
const START_AHEAD_MS = 100;

/** One process per argument list (a fixture that calls startTogether), started together; each settles with what it
 *  printed after "ready", or its exit code and stderr. Resolves once every process is ready (or has already ended). */
async function together(script: string, argLists: string[][]): Promise<Promise<string>[]> {
  const env = processEnv(sandbox());
  const children = argLists.map((args) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdin.on('error', () => {}); // a process that already ended can't take the start time; its exit says why
    let out = '';
    let err = '';
    let isReady: () => void = () => {};
    const ready = new Promise<void>((ok) => (isReady = ok));
    child.stdout.on('data', (d) => {
      out += d;
      if (out.startsWith('ready\n')) isReady();
    });
    child.stderr.on('data', (d) => (err += d));
    const done = new Promise<string>((ok, no) =>
      child.on('close', (code) => (code === 0 && out.startsWith('ready\n') ? ok(out.slice('ready\n'.length)) : no(new Error(`exit ${code}: ${err}`)))),
    );
    done.catch(() => {}); // the caller reads every result; none is left unhandled while the others get ready
    return { child, ready: Promise.race([ready, done.then(() => {}, () => {})]), done };
  });
  await Promise.all(children.map((c) => c.ready));
  const startAt = `${Date.now() + START_AHEAD_MS}\n`;
  for (const c of children) c.child.stdin.end(startAt);
  return children.map((c) => c.done);
}

describe('nothing lost (histories.concurrent)', () => {
  it('20 publishes of one name from 20 processes become versions 1..20, no gaps, each retrievable', async () => {
    const dir = join(sandbox(), 'catalog');
    (await openLocalCatalog(dir)).close(); // create the schema once, so the race is only on publishing
    const script = join(import.meta.dirname, 'fixtures', 'publish-one.ts');
    const outs = await Promise.all(await together(script, Array.from({ length: 20 }, (_, i) => [dir, String(i + 1)])));
    const results = outs.map((o) => JSON.parse(o) as { n: number; version: number; created: boolean; fingerprint: string });
    expect(results.every((r) => r.created)).toBe(true);
    expect(results.map((r) => r.version).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const catalog = await openLocalCatalog(dir);
    try {
      for (const r of results) {
        const got = await catalog.fetch({ name: 'concurrent-skill', version: r.version });
        expect(got.fingerprint).toBe(r.fingerprint);
        expect(Buffer.from(inlineFiles(got).find((f) => f.path === 'SKILL.md')!.content_base64, 'base64').toString()).toContain(`Variant ${r.n}.`);
      }
      expect((await catalog.versions({ name: 'concurrent-skill' })).latest).toBe(20);
    } finally {
      catalog.close();
    }
  }, 60_000);
});

describe('a fresh catalog opened by several processes at once (two assistants, or a server and the CLI, starting together)', () => {
  // Without the retry around the switch to WAL, 40 to 50% of the rounds of 10 simultaneous opens have one that fails
  // ("database is locked"), measured on a busy machine. Six rounds let such a regression pass in 2 to 5% of the runs;
  // 30 rounds, in fewer than one in a million.
  const ROUNDS = 30;

  it('every open succeeds: the switch to WAL waits its turn', async () => {
    const script = join(import.meta.dirname, 'fixtures', 'open-one.ts');
    for (let round = 0; round < ROUNDS; round++) {
      const dir = join(sandbox(), 'catalog');
      const outs = await Promise.allSettled(await together(script, Array.from({ length: 10 }, () => [dir])));
      const failed = outs.filter((o) => o.status === 'rejected').map((o) => String((o as PromiseRejectedResult).reason));
      expect(failed, `round ${round}`).toEqual([]);
    }
  }, 180_000);
});
