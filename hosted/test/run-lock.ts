// One hosted run at a time on a machine. The stand-in's server closes every connection, so one run leaves thousands of
// local ports waiting to close for about 30 s; two runs at once can use up the machine's ephemeral ports (the person's
// own programs share them). A run holds a fixed 127.0.0.1 port for its whole length: the kernel frees it when the
// process ends, so no lock is ever left behind, and nothing is written anywhere. It starts only once the ports waiting
// to close are few (the drain of the run before it).

import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';

/** The lock's port: below the ephemeral range, so no outgoing connection is ever given it. */
export const RUN_LOCK_PORT = 47_390;
/** Ports waiting to close above which a run waits. */
export const FREE_PORTS_LIMIT = 4000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const bind = (port: number) =>
  new Promise<Server | undefined>((resolve, reject) => {
    const s = createServer();
    s.once('error', (e: NodeJS.ErrnoException) => (e.code === 'EADDRINUSE' ? resolve(undefined) : reject(e)));
    // exclusive: a worker in a cluster never shares it.
    s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(s));
  });

export async function takeRunLock(o: { port?: number; timeoutMs: number; pollMs?: number }): Promise<{ release(): Promise<void> }> {
  const port = o.port ?? RUN_LOCK_PORT;
  const started = Date.now();
  for (let said = false; ; ) {
    const s = await bind(port);
    if (s) return { release: () => new Promise<void>((r) => s.close(() => r())) };
    if (Date.now() - started >= o.timeoutMs) {
      throw new Error(`another hosted test run holds 127.0.0.1:${port}; waited ${Math.round(o.timeoutMs / 1000)} s. Run the hosted tests one at a time on a machine.`);
    }
    if (!said) {
      process.stderr.write(`waiting for another hosted test run (it holds 127.0.0.1:${port})\n`);
      said = true;
    }
    await sleep(o.pollMs ?? 500);
  }
}

/** How many TCP connections on this machine are waiting to close, or undefined when netstat can't say. */
export const timeWaitCount = () =>
  new Promise<number | undefined>((resolve) => {
    execFile('/usr/sbin/netstat', ['-an', '-p', 'tcp'], { env: { PATH: '/usr/bin:/bin' }, maxBuffer: 64 * 1024 * 1024 }, (err, out) => {
      if (err) return resolve(undefined);
      resolve(out.split('\n').filter((l) => /\bTIME_WAIT\b/.test(l)).length);
    });
  });

export async function waitForFreePorts(o: { count?: () => Promise<number | undefined>; limit?: number; timeoutMs: number; pollMs?: number }): Promise<void> {
  const count = o.count ?? timeWaitCount;
  const limit = o.limit ?? FREE_PORTS_LIMIT;
  const started = Date.now();
  for (let said = false; ; ) {
    const n = await count();
    if (n === undefined || n < limit) return;
    if (Date.now() - started >= o.timeoutMs) {
      throw new Error(`${n} local ports are waiting to close (a run starts under ${limit}); waited ${Math.round(o.timeoutMs / 1000)} s.`);
    }
    if (!said) {
      process.stderr.write(`waiting for local ports to close: ${n} (a run starts under ${limit})\n`);
      said = true;
    }
    await sleep(o.pollMs ?? 2000);
  }
}
