// The AWS stand-in for the hosted adapters' tests: moto in server mode from emulator/.venv (or the full path in
// SKILLS_CATALOG_MOTO), on 127.0.0.1 only, in its own
// process group, stopped after each test file (SIGTERM to the group, SIGKILL after 5 s). It prints its pid so a run's
// after-check can find a leftover. SDK clients get fake static credentials and this endpoint, never the person's, and a
// no-wait agent (no-wait-agent.ts).

import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { noWaitAgent } from './no-wait-agent.ts';

const MOTO = fileURLToPath(new URL('../emulator/.venv/bin/moto_server', import.meta.url));

/** How moto is started: from this project's environment, or from the full path in SKILLS_CATALOG_MOTO (an existing
 *  environment, used read-only). Its own environment holds nothing of the person's: no AWS settings, no profile, no
 *  metadata service, a plain PATH; PYTHONDONTWRITEBYTECODE is passed through when set, so a read-only environment gets
 *  no bytecode written into it. */
export function motoCommand(from: Record<string, string | undefined> = process.env): { path: string; env: Record<string, string> } {
  const given = from['SKILLS_CATALOG_MOTO'];
  if (given !== undefined && !isAbsolute(given)) throw new Error('SKILLS_CATALOG_MOTO must be the full path to moto_server');
  const env: Record<string, string> = { PATH: '/usr/bin:/bin', AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null' };
  const bytecode = from['PYTHONDONTWRITEBYTECODE'];
  if (bytecode !== undefined) env['PYTHONDONTWRITEBYTECODE'] = bytecode;
  return { path: given ?? MOTO, env };
}

// Each client spread from this gets its own handler on a no-wait agent (the getter runs at each spread, so one client's
// destroy() never takes down another's).
export const FAKE = {
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  get requestHandler() {
    return { httpAgent: noWaitAgent() };
  },
} as const;

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
  const moto = motoCommand();
  const p = spawn(moto.path, ['-H', '127.0.0.1', '-p', String(port)], { env: moto.env, detached: true, stdio: 'ignore' });
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
