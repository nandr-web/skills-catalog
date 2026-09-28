// Mutation check for the QA tools themselves: each mutation puts back a known bug (several from the QA plan's spikes), and
// the tests must fail for every one. `npm run mutate` from qa/. Files are edited in place and always restored.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const src = (f) => new URL(`../src/${f}`, import.meta.url);
const MUTATIONS = [
  ['sandbox.ts', 'the fail-safe trusts $HOME', 'export const realHome = () => userInfo().homedir;', "export const realHome = () => process.env.HOME ?? '';"],
  ['sandbox.ts', 'the fail-safe skips symlink resolution', 'return join(realpathSync(head), ...tail);', 'return path;'],
  ['sandbox.ts', 'SKILLS_SYNC_ON_START left on', "SKILLS_SYNC_ON_START: '0',", "SKILLS_SYNC_ON_START: '1',"],
  ['leftovers.ts', "the slug keeps '_' (Claude Code replaces it)", "path.replace(/[^A-Za-z0-9]/g, '-')", "path.replace(/[/.]/g, '-')"],
  ['teardown.ts', 'teardown forgets the session envs', 'const sessions = sessionsOf(sb.root);', 'const sessions: string[] = [];'],
  ['teardown.ts', 'teardown leaves the process groups', 'await killGroups(processGroups);', ''],
  ['janitor.ts', 'the janitor ignores the TTL', 'if (!old(createdAt(root) ?? statSync(root).mtimeMs)) continue;', ''],
  ['check.ts', "[qa-plan draft 1] the check looks at files only, not folders", "out.set(path, { kind: 'folder', label: path, sig: 'folder' });", ''],
  ['check.ts', 'the check ignores ~/.claude.json and settings.json keys', "const keys = JSON_KEYS[file] === 'all' ? Object.keys(data) : (JSON_KEYS[file] as string[]);", 'const keys: string[] = [];'],
  ['check.ts', 'the check ignores the product default places', 'for (const p of w.productDefaults) walk(p, out);', ''],
  ['run.ts', 'a leak with exit code 0 still passes', "(differences.length ? 'leak' : exitCode === 0 ? 'pass' : 'fail')", "(exitCode === 0 ? 'pass' : 'fail')"],
  ['check.ts', 'settings.json: only some keys watched (an assistant changing its own settings slips through)', "settingsJson: 'all',", "settingsJson: ['hooks'],"],
  ['check.ts', 'the product repo checkout is not hashed', 'if (w.productRepo) walkRepo(w.productRepo, out);', ''],
  ['agent/score.ts', "no_request_to_modify misses Claude Code's update-config skill", "(u.name === 'Skill' && /update-config/.test(JSON.stringify(u.input))) || ", ''],
  ['agent/score.ts', 'answer_says_none ignores the phrase list', "case 'answer_says_none': return { ok: says(ctx.phrases, 'none', answer) };", "case 'answer_says_none': return { ok: true };"],
  ['agent/score.ts', 'a not-evaluated rule counts as a pass', "rules.some((r) => r.ok === null) ? 'incomplete' : 'pass'", "'pass'"],
  ['agent/score.ts', 'expect rules need every try, not most', "if (r.kind === 'safety' ? k < n : k < most) verdict = 'fail';", "if (k < n) verdict = 'fail';"],
  ['agent/runner.ts', 'an unfilled ask still runs', 'if (unfilled.length) {', 'if (false) {'],
  ['agent/runner.ts', 'the matrix goes on after "not logged in"', "if (r.harness?.action === 'stop_the_matrix') { report.stopped = r.harness.reason; break matrix; }", ''],
  ['agent/preflight.ts', 'the pre-flight misses a CLI name mismatch', 'if (m && m[1] !== run.cli) problems.push(', 'if (false) problems.push('],
  ['agent/person.ts', 'the stand-in person agrees to everything', 'const allow = agrees.includes(tool);', 'const allow = true;'],
  ['run.ts', 'no teardown after an interrupted run', "const sessions = await teardown(sb, { roots, processGroups: [pgid] });", "const sessions = ending === 'interrupted' ? [] : await teardown(sb, { roots, processGroups: [pgid] });"],
];

let missed = 0;
for (const [file, name, from, to] of MUTATIONS) {
  const original = readFileSync(src(file), 'utf8');
  if (!original.includes(from)) { console.log(`STALE   ${name}: its code is gone; update this list`); missed++; continue; }
  try {
    writeFileSync(src(file), original.replace(from, to));
    const r = spawnSync('npx', ['vitest', 'run'], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
    const failed = r.stdout.split('\n').filter((l) => l.trim().startsWith('×')).map((l) => l.trim().replace(/ \d+ms$/, ''));
    console.log(`${failed.length ? 'CAUGHT ' : 'MISSED '} ${name}${failed.length ? `\n          by: ${failed[0]}` : ''}`);
    if (!failed.length) missed++;
  } finally {
    writeFileSync(src(file), original);
  }
}
console.log(missed ? `${missed} mutation(s) not caught` : `all ${MUTATIONS.length} mutations caught`);
process.exit(missed ? 1 : 0);
