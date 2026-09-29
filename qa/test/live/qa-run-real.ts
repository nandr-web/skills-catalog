// The check of `qa run` itself on the real machine (the QA plan §6 step 7), run only by hand, never from the test suite:
//   node test/live/qa-run-real.ts
// It reads the real places (read-only), runs one `qa run` (whose teardown and janitor act on the real machine, under the
// safe-deletion rules), reads them again, and exits 1 if anything changed or the run didn't say "nothing left behind".
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compare, snapshot, watchOn } from '../../src/check.ts';
import { realClaudeCache, realClaudeTmp, realHome } from '../../src/safe-delete.ts';
import { sandboxBase } from '../../src/sandbox.ts';

if (process.env.VITEST) { console.error('qa-run-real: run this by hand, never from a test process'); process.exit(2); }
const home = realHome();
const real = { tmp: tmpdir(), home, roots: { claudeDir: join(home, '.claude'), claudeTmp: realClaudeTmp(), claudeCache: realClaudeCache() } };
const every = watchOn(real, { sandboxRoot: sandboxBase(real.tmp) });   // its slug prefixes every qa run's leftover names
const before = snapshot(every);
const cli = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
const r = spawnSync(process.execPath, [cli, 'run', '--', process.execPath, '-e', "require('fs').writeFileSync(process.env.SKILLS_HOME + '/x', '1')"], { encoding: 'utf8' });
const changed = compare(before, snapshot(every));
process.stderr.write(r.stderr);
for (const d of changed) console.log(`changed on the real machine: ${d.what}`);
const ok = r.status === 0 && !changed.length && /nothing left behind/.test(r.stderr);
console.log(ok ? 'qa-run-real: qa run left nothing behind on the real machine' : 'qa-run-real: FAILED');
process.exit(ok ? 0 : 1);
