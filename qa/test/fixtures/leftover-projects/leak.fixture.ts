// Each project's leak (run only by test/temp-folders.test.ts; both projects run this file): its folder is made again
// after the test removed it, and it says where.
import { appendFileSync, mkdirSync } from 'node:fs';
import { afterAll, it } from 'vitest';
import { scratch } from '../../machine.ts';

let d = '';
it('leaves its folder behind', () => {
  d = scratch('qa-left-');
  appendFileSync(process.env['CANARY_OUT']!, `${d}\n`);
});
afterAll(() => mkdirSync(d));
