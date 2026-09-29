// The child's side of starting several processes together (test/storage-processes.test.ts has the parent's): say
// "ready" on stdout once the imports are loaded, read the shared start time from stdin, and spin until it.

import { createInterface } from 'node:readline';

export async function startTogether(): Promise<void> {
  process.stdout.write('ready\n');
  const lines = createInterface({ input: process.stdin });
  const startAt = await new Promise<number>((ok) => lines.once('line', (l) => ok(Number(l))));
  lines.close();
  while (Date.now() < startAt) {
    // spin until the shared start
  }
}
