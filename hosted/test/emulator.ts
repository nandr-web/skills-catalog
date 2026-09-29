// The AWS stand-in for the hosted adapters' tests: moto in server mode from emulator/.venv, on 127.0.0.1 only, in its own
// process group, stopped after each test file (SIGTERM to the group, SIGKILL after 5 s). It prints its pid so a run's
// after-check can find a leftover. SDK clients get fake static credentials and this endpoint, never the person's.

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const MOTO = fileURLToPath(new URL('../emulator/.venv/bin/moto_server', import.meta.url));

export const FAKE = { region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } as const;

export type Emulator = { endpoint: string; stop(): Promise<void> };

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const exited = (p: ChildProcess, ms: number) =>
  new Promise<boolean>((resolve) => {
    if (p.exitCode !== null || p.signalCode !== null) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    p.once('exit', () => {
      clearTimeout(t);
      resolve(true);
    });
  });

export async function startEmulator(): Promise<Emulator> {
  const port = await freePort();
  // Nothing of the person's: no AWS settings, no profile, no metadata service; a plain PATH.
  const env = { PATH: '/usr/bin:/bin', AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' };
  const p = spawn(MOTO, ['-H', '127.0.0.1', '-p', String(port)], { env, detached: true, stdio: 'ignore' });
  process.stderr.write(`moto pid ${p.pid} port ${port}\n`);
  const endpoint = `http://127.0.0.1:${port}`;
  const stop = async () => {
    try {
      process.kill(-p.pid!, 'SIGTERM');
    } catch {
      return;
    }
    if (!(await exited(p, 5000))) {
      try {
        process.kill(-p.pid!, 'SIGKILL');
      } catch {
        // already gone
      }
      await exited(p, 2000);
    }
  };
  for (let waited = 0; ; waited += 100) {
    try {
      if ((await fetch(`${endpoint}/moto-api/`)).ok) return { endpoint, stop };
    } catch {
      // not listening yet
    }
    if (waited > 20_000 || p.exitCode !== null) {
      await stop();
      throw new Error(`the emulator didn't start on ${endpoint}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}
