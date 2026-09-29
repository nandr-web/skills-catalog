#!/usr/bin/env node
// A fake catalog command line for the stand-in's tests. It reports through its own SKILLS_HOME: cli-calls.jsonl, one line
// per run (its arguments, its environment's names, its folder, whether stdin was a terminal). It prints one line naming
// what it was asked and exits 0; a skill named "fails" makes it print a refusal on stderr and exit 1.
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = process.env.SKILLS_HOME;
mkdirSync(home, { recursive: true });
const args = process.argv.slice(2);
appendFileSync(join(home, 'cli-calls.jsonl'), JSON.stringify({ args, env: Object.keys(process.env).sort(), cwd: process.cwd(), tty: !!process.stdin.isTTY }) + '\n');
process.stdout.write(`fake cli: ${args.join(' ')}\n`);
if (args.includes('fails')) {
  process.stderr.write('fake cli: refused\n');
  process.exitCode = 1;
}
