// The canary (run only by test/temp-folders.test.ts, never by the suite): a test that leaves a child of its own writing
// into its folder for 3 s after it ends, so the folder is made again after its removal. It says where, and the child's pid.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { scratch } from '../../machine.ts';

it('leaves a child writing into its own folder', () => {
  const d = scratch('qa-canary-');
  const writer = spawn(process.execPath, ['-e', "const fs = require('fs'), path = require('path'); const d = process.argv[1]; const t = setInterval(() => { try { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'x'), 'x'); } catch {} }, 20); setTimeout(() => { clearInterval(t); process.exit(0); }, 3000);", d], { detached: true, stdio: 'ignore' });
  writer.unref();
  writeFileSync(process.env['CANARY_OUT']!, JSON.stringify({ folder: d, writer: writer.pid }));
});
