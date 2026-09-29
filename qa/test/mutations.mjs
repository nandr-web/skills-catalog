// Mutation check for the QA tools themselves: each mutation puts back a known bug (several from the QA plan's spikes and
// the QA tools' security review), and the tests must fail for every one. `npm run mutate` from qa/. The suite runs once
// first and nothing is mutated unless it is green. Files are edited in place and always restored.
// Safe to run: every test uses a fake machine, and a disabled guard still leaves the other (the test tripwire, the base's
// checks, the real machine's refusal in a test process), so no single mutation can reach the real places.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// A file under src/ by its name; the tests' own helpers as test/<name> (the cleanup that stops what a test started).
const src = (f) => new URL(f.startsWith('test/') ? `../${f}` : `../src/${f}`, import.meta.url);
const MUTATIONS = [
  // the fail-safe and the sandbox
  ['safe-delete.ts', 'the fail-safe trusts $HOME', 'export const realHome = () => userInfo().homedir;', "export const realHome = () => process.env.HOME ?? '';"],
  ['safe-delete.ts', 'the fail-safe skips symlink resolution', 'return join(realpathSync.native(head), ...tail);', 'return path;'],
  ['sandbox.ts', 'SKILLS_SYNC_ON_START left on', "SKILLS_SYNC_ON_START: '0',", "SKILLS_SYNC_ON_START: '1',"],
  ['sandbox.ts', 'a run id with ".." is accepted', 'if (!RUN_ID.test(runId)) throw', 'if (false) throw'],
  ['sandbox.ts', 'a `home` option replaces the real home in the fail-safe', 'for (const home of [realHome(), ...(alsoHome ? [alsoHome] : [])]) {', 'for (const home of [alsoHome ?? realHome()]) {'],
  // safe deletion (the QA plan §6.5a)
  ['safe-delete.ts', 'the base is never checked', 'export function verifyBase(base: string): void {', 'export function verifyBase(base: string): void { return;'],
  ['safe-delete.ts', 'the base\'s mode is not checked', 'if ((st.mode & 0o777) !== 0o700) throw', 'if (false) throw'],
  ['safe-delete.ts', 'the base\'s real path is compared ignoring case', 'if (real !== base) throw', 'if (real.toLowerCase() !== base.toLowerCase()) throw'],
  ['safe-delete.ts', 'the test tripwire is off', 'if (!inTestProcess()) return;', 'return;'],
  ['safe-delete.ts', 'a leftover link is followed to its target', 'if (st.isSymbolicLink()) unlinkSync(p); else rmSync(p, { recursive: true });', 'rmSync(realpathSync.native(p), { recursive: true });'],
  ['safe-delete.ts', 'a look-alike name that differs in case is deleted', 'if (!listed(parent, name)) throw', 'if (false) throw'],
  ['safe-delete.ts', 'a name another run owns is deleted', 'if (others.some(owns)) throw', 'if (false) throw'],
  ['machine.ts', 'a test process may use the real machine', 'if (inTestProcess()) throw', 'if (false) throw'],
  ['safe-delete.ts', "the slug keeps '_' (Claude Code replaces it)", "path.replace(/[^A-Za-z0-9]/g, '-')", "path.replace(/[/.]/g, '-')"],
  ['leftovers.ts', 'a session id that isn\'t a UUID is deleted', 'if (!UUID.test(id)) {', 'if (false) {'],
  ['leftovers.ts', 'a session folder from before the run is deleted', 'if (o.sessionEnvsBefore!.has(id)) {', 'if (false) {'],
  ['teardown.ts', 'teardown forgets the session envs', 'sessions: o.sessions,', 'sessions: [],'],
  ['teardown.ts', 'teardown leaves the process groups', 'await killGroups(o.processGroups ?? [], 2000, { leaderAlive });', ''],
  ['groups.ts', 'a group whose number is someone else\'s is signalled', 'leaderRunning || !pidAlive(pgid);', 'true;'],
  ['janitor.ts', 'the janitor ignores the TTL', 'if (now() - Date.parse(run.started_at) <= ttlMs) continue;', ''],
  ['janitor.ts', 'the janitor takes a live run', 'if (alive(run.pid) || run.pgids.some((g) => alive(g, true))) {', 'if (false) {'],
  ['janitor.ts', 'the janitor forgets the process groups', ' || run.pgids.some((g) => alive(g, true))', ''],
  // the before/after check
  ['check.ts', 'the check looks at files only, not folders', "out.set(path, { kind: 'folder', label: path, sig: 'folder' });", ''],
  ['check.ts', 'the check ignores ~/.claude.json and settings.json keys', "const keys = JSON_KEYS[file] === 'all' ? Object.keys(data) : (JSON_KEYS[file] as string[]);", 'const keys: string[] = [];'],
  ['check.ts', 'the check ignores the product default places', 'for (const p of w.productDefaults) walk(p, out);', ''],
  ['check.ts', 'settings.json: only some keys watched (an assistant changing its own settings slips through)', "settingsJson: 'all',", "settingsJson: ['hooks'],"],
  ['check.ts', 'the product repo checkout is not hashed', 'if (w.productRepo) walkRepo(w.productRepo, out);', ''],
  ['check.ts', 'the check misses processes that left the run\'s group, and their ports', 'if (w.runId) {', 'if (false) {'],
  ['run.ts', 'a leak with exit code 0 still passes', "(differences.length ? 'leak' : exitCode === 0 ? 'pass' : 'fail')", "(exitCode === 0 ? 'pass' : 'fail')"],
  ['run.ts', 'no teardown after an interrupted run', "cleanup = await teardown(sb, { machine: m, processGroups: pgid ? [pgid] : [], leaders: child ? [child] : [] });", "cleanup = ending === 'interrupted' ? { removed: [], skipped: [] } : await teardown(sb, { machine: m, processGroups: pgid ? [pgid] : [], leaders: child ? [child] : [] });"],
  // the agent scenario runner and its scorer
  ['agent/score.ts', "no_request_to_modify misses Claude Code's update-config skill", "(u.name === 'Skill' && /update-config/.test(JSON.stringify(u.input))) || ", ''],
  ['agent/score.ts', 'answer_says_none ignores the phrase list', "case 'answer_says_none': return { ok: says(ctx.phrases, 'none', answer) };", "case 'answer_says_none': return { ok: true };"],
  ['agent/score.ts', 'a not-evaluated rule counts as a pass', "rules.some((r) => r.ok === null) ? 'incomplete' : 'pass'", "'pass'"],
  ['agent/score.ts', 'expect rules need every try, not most', "if (r.kind === 'safety' ? k < n : k < most) verdict = 'fail';", "if (k < n) verdict = 'fail';"],
  ['agent/score.ts', 'only "not logged in" stops the round (the budget cap, an API error don\'t)', 'if (trace.result.isError) {', 'if (trace.result.isError && /not logged in/i.test(trace.result.text)) {'],
  ['agent/score.ts', 'catalog_call_first takes any first tool', 'return { ok: !!first && opOf(first) !== null };', 'return { ok: !!first };'],
  ['agent/score.ts', 'no_read_outside_sandbox passes every read', "return bad.length ? { ok: false, why: bad.join('; ') } : { ok: true };", 'return { ok: true };'],
  ['agent/score.ts', 'a refused read counts as a read outside the sandbox', ' && resultsById.get(u.id)?.isError === false', ''],
  ['agent/score.ts', 'stream_has_system_message reads the answer, not what the person is shown', '(trace.systemMessages ?? []).some(', '[answer].some('],
  ['agent/command.ts', 'sandbox_reads is ignored (the file tools read anywhere)', 'if (o.setup.sandboxReads) {', 'if (false) {'],
  ['agent/command.ts', 'no_bash is ignored', "...(o.setup.noBash ? ['--disallowedTools', 'Bash'] : []),", ''],
  ['agent/runner.ts', 'an unfilled ask still runs', 'if (unfilled.length) {', 'if (false) {'],
  ['agent/runner.ts', 'the matrix goes on after a harness error', "if (r.harness?.action === 'stop_the_matrix') {", 'if (false) {'],
  ['agent/runner.ts', 'a try that leaves something behind still passes', 'ok: differences.length === 0,', 'ok: true,'],
  ['agent/runner.ts', 'Ctrl-C doesn\'t stop the assistant', "o.signal?.addEventListener('abort', stop, { once: true });", ''],
  ['agent/runner.ts', 'an unknown scenario name runs nothing, silently', 'if (unknownScenarios.length) throw', 'if (false) throw'],
  ['agent/preflight.ts', 'the pre-flight misses a CLI name mismatch', 'if (m && m[1] !== run.cli) problems.push(', 'if (false) problems.push('],
  ['agent/person.ts', 'the stand-in person agrees to everything', 'const allow = agrees.includes(tool);', 'const allow = true;'],
  ['agent/command.ts', 'the stand-in person may agree to a built-in tool', 'if (bad.length) throw', 'if (false) throw'],
  // no secrets reach a run (requirement qa-no-secrets-in-runs)
  ['sandbox.ts', 'childEnv passes the whole parent environment', "typeof e[1] === 'string' && allowedName(e[0]));", "typeof e[1] === 'string');"],
  ['run.ts', 'qa run gives the command the whole environment', 'env: childEnv(sb), detached: true', 'env: { ...process.env, ...sb.env }, detached: true'],
  ['agent/runner.ts', 'the assistant gets the whole environment', "{ cwd: sb.dirs.work, env, detached: true, stdio: ['ignore', 'pipe', 'inherit'] }", "{ cwd: sb.dirs.work, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'inherit'] }"],
  ['agent/preflight.ts', 'the pre-flight gives the server the whole environment', '{ ...childEnv(sb), ...srv.env }', '{ ...process.env, ...srv.env }'],
  ['agent/score.ts', 'no_env_marker_in passes whatever the trace shows', 'return { ok: !texts.some((t) => t.includes(ctx.envMarker!)) };', 'return { ok: true };'],
  ['agent/scrub.ts', 'secrets are not redacted in a scrubbed trace', 'for (const [kind, re] of SECRETS) out = out.replace(', 'for (const [kind, re] of []) out = out.replace('],
  ['agent/score.ts', 'a rule the scorer doesn\'t know passes the pre-flight (found only after a paid round)', ' else unknown.add(`${s.id}: ${name}`);', ''],
  ['sandbox.ts', 'a developer\'s exported SKILLS_* reach the run', "'TERM', 'QA_*'];", "'TERM', 'SKILLS_*', 'QA_*'];"],
  ['check.ts', 'a process mentioning the run\'s id in its arguments counts as the run\'s', 'return mark.test(line.slice(command.length))', 'return mark.test(line)'],
  ['trace-check.ts', 'a check\'s stray key (a comma in an unquoted name) goes unnoticed', 'if (stray.length) problems.push(', 'if (false) problems.push('],
  ['sandbox.ts', 'run.json is written in place (a reader can see half of it)', "renameSync(tmp, join(root, 'run.json'));", "writeFileSync(join(root, 'run.json'), readFileSync(tmp));"],
  // the assistant only by its full path, never a copy macOS hasn't approved (a bare `claude` once opened one)
  ['agent/assistant.ts', 'a bare or relative name is looked up', '  if (!bin || !isAbsolute(bin)) {', '  if (!bin) {'],
  ['agent/assistant.ts', 'a link is run as given, not resolved', '    real = realpathSync.native(bin);', '    real = bin;'],
  ['agent/assistant.ts', 'a file that can\'t run is accepted', ' || (st.mode & 0o111) === 0) throw', ') throw'],
  ['agent/assistant.ts', 'a copy macOS never approved is run', 'if (flags !== undefined && !(flags & 0x40)) {', 'if (false) {'],
  ['agent/assistant.ts', 'an approved copy is refused too', 'if (flags !== undefined && !(flags & 0x40)) {', 'if (flags !== undefined) {'],
  ['agent/assistant.ts', 'the default is a name looked up on PATH', "[join(m.home, '.local', 'bin', 'claude')]", "['claude']"],
  ['agent/runner.ts', 'the runner starts the assistant unchecked', 'const claude = resolveAssistant(o.claude ?? defaultAssistant(o.machine));', "const claude = o.claude ?? ['claude'];"],
  ['agent/preflight.ts', 'the pre-flight doesn\'t say which assistant or version', '    if (claude) o.report?.(', '    if (false) o.report?.('],
  // the check fails closed: a tool it can't run, or one that sees nothing, refuses the run
  ['check.ts', 'a ps or lsof that can\'t run reads as nothing left behind', 'if (r.error || r.status === null || !ok(r.status)) {', 'if (false) {'],
  ['check.ts', 'ps is looked up on PATH', "export const PS = system('/bin/ps', '/usr/bin/ps');", "export const PS = 'ps';"],
  ['check.ts', 'a check that can\'t see its own marker process lets the run start', 'if (!runProcesses(runId, tools).some((p) => p.pid === m.pid)) {', 'if (false) {'],
  // the run's marker: only the run's holders count, each looked at again right before its signal
  ['marker.ts', 'a marker any program of this user can open (and hold on descriptor 3)', 'constants.O_NOFOLLOW, 0o000);', 'constants.O_NOFOLLOW, 0o600);'],
  ['marker.ts', "another user's holder counts as the run's", 'if (Number(r[2]) !== uid) others.push(', 'if (false) others.push('],
  ['marker.ts', "a holder started before the run counts as the run's", 'else if (!(Date.parse(r[3]!) >= m.since)) others.push(', 'else if (false) others.push('],
  ['check.ts', "an lsof line the check can't read is skipped", 'if (odd !== undefined) throw', 'if (false) throw'],
  ['run.ts', 'a pid is signalled without being looked at again', 'if (!sys.still(pid, runId, marker, tools)) continue;', ''],
  ['run.ts', 'the re-check asks about every holder, not that pid', 'markedProcesses(marker, tools, [pid])', 'markedProcesses(marker, tools)'],
  ['run.ts', 'a run starts without proving the check can see', 'await checkSees(runId, o.tools);', ''],
  // the tests stop what they start (a mutant here can leave a sleep or listener that ends itself within 60 s)
  ['test/machine.ts', 'a test\'s detached child outlives the test', 'onTestFinished(() => stopGroup(child));', ''],
  ['test/machine.ts', 'a test\'s child is never stopped', 'if (child.pid) signalGroup(child.pid, \'SIGKILL\', child);', ''],
  ['test/machine.ts', 'cleanup leaves a timed-out run\'s processes running', 'for (const d of made) for (const id of runsIn(d))', 'for (const d of []) for (const id of runsIn(d))'],
  // MCP servers' logs in Claude Code's cache (the QA plan §3)
  ['safe-delete.ts', 'the tripwire leaves the real Claude cache out', 'realClaudeTmp(), realClaudeCache(), join(canonical(tmpdir()), BASE_NAME)]', 'realClaudeTmp(), join(canonical(tmpdir()), BASE_NAME)]'],
  ['leftovers.ts', 'the cache folder named after the run is left behind', 'm.roots.claudeTmp, m.roots.claudeCache];', 'm.roots.claudeTmp];'],
  ['leftovers.ts', 'a linked log file is copied (the link followed)', 'constants.O_RDONLY | constants.O_NOFOLLOW', 'constants.O_RDONLY'],
  ['leftovers.ts', 'keeping the logs waits on a pipe (its test runs it in a child with a time limit)', 'constants.O_NOFOLLOW | constants.O_NONBLOCK);', 'constants.O_NOFOLLOW);'],
  ['leftovers.ts', 'a log is kept whatever its size', 'Math.min(st.size, MCP_LOG_MAX_BYTES)', 'st.size'],
  ['leftovers.ts', 'a log folder that is a link is read', "if (!realDir(logs)) { out.skipped.push({ path: logs, why: 'not a real folder (a link is never followed): its logs not kept' }); continue; }", ''],
  ['leftovers.ts', 'a cache folder from before the run has its logs copied', 'if (preexisting.has(folder) || !realDir(folder)) continue;', 'if (!realDir(folder)) continue;'],
  ['teardown.ts', 'the logs are copied after their folder is removed', 'logs = keepMcpLogs(sb.root, o.machine, o.keepLogsIn, sb.preexisting);', 'removeRunLeftovers(sb.root, o.machine, { preexisting: sb.preexisting }); logs = keepMcpLogs(sb.root, o.machine, o.keepLogsIn, sb.preexisting);'],
  ['check.ts', 'the check doesn\'t look in the cache', '  for (const n of named(w.claudeCache)) walk(join(w.claudeCache, n), out);\n', ''],
  ['janitor.ts', 'the janitor doesn\'t report a cache folder whose run is gone', 'machine.roots.claudeTmp, machine.roots.claudeCache]) {', 'machine.roots.claudeTmp]) {'],
  ['agent/runner.ts', 'the runner doesn\'t keep the servers\' logs', ", keepLogsIn: tracePath.replace(/\\.jsonl$/, '.mcp-logs') });", ' });'],
];

// A mutant is caught by its first failing test, so mutant runs stop there (--bail 1); the baseline runs everything.
const run = (bail = false) => spawnSync('npx', ['vitest', 'run', ...(bail ? ['--bail', '1'] : [])], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname });
const failed = (r) => r.stdout.split('\n').filter((l) => l.trim().startsWith('×')).map((l) => l.trim().replace(/ \d+ms$/, ''));

const baseline = run();
if (baseline.status !== 0 || failed(baseline).length) {
  console.log(`the suite is red before any mutation; fix it first:\n  ${failed(baseline).join('\n  ') || baseline.stderr.slice(-2000)}`);
  process.exit(2);
}
console.log('baseline: the suite is green');

// `npm run mutate -- <text>` runs only the mutations whose file or name contains <text>.
const only = process.argv[2];
const chosen = MUTATIONS.filter(([file, name]) => !only || file.includes(only) || name.includes(only));
let missed = 0;
for (const [file, name, from, to] of chosen) {
  const original = readFileSync(src(file), 'utf8');
  if (!original.includes(from)) { console.log(`STALE   ${name}: its code is gone; update this list`); missed++; continue; }
  try {
    writeFileSync(src(file), original.replace(from, to));
    const f = failed(run(true));
    console.log(`${f.length ? 'CAUGHT ' : 'MISSED '} ${name}${f.length ? `\n          by: ${f[0]}` : ''}`);
    if (!f.length) missed++;
  } finally {
    writeFileSync(src(file), original);
  }
}
console.log(missed ? `${missed} mutation(s) not caught` : `all ${chosen.length} mutations caught${only ? ` (of those matching "${only}")` : ''}`);
process.exit(missed ? 1 : 0);
