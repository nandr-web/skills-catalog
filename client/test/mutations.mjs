// Mutation check for the client: each mutation puts back a bug the tests are there to catch, and the tests must fail
// for every one. `npm run mutate` from client/ (`npm run mutate -- <text>` runs only the matching ones). The suite runs
// once first and nothing is mutated unless it is green. Files are edited in place and always restored, so never
// commit while it runs. Safe: every test's server runs with SKILLS_HOME, the catalog and HOME in a sandbox folder, and
// each run gets a temp folder of its own (TMPDIR), removed after it, so a run stopped at its first failure leaves nothing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// A client file by its path under src/; a core file the client's tests cover as core:<path under core/src/>.
const src = (f) => new URL(f.startsWith('core:') ? `../../core/src/${f.slice(5)}` : `../src/${f}`, import.meta.url);
const MUTATIONS = [
  // the protocol
  ['mcp/server.ts', 'a notification gets a reply', "if (!('id' in msg)) return undefined;", "if (!('id' in msg)) return reply(0, {});"],
  ['mcp/server.ts', 'any protocol version the client asks for is echoed', 'PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0]', "(typeof asked === 'string' ? asked : PROTOCOL_VERSIONS[0])"],
  ['mcp/server.ts', '2025-03-26 is offered (it requires batches)', "['2025-11-25', '2025-06-18', '2024-11-05']", "['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']"],
  ['mcp/server.ts', 'an unknown tool is a tool result, not -32602', 'if (!def) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params[\'name\']}`);', "if (!def) return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };"],
  ['mcp/server.ts', 'an unknown method is answered', 'throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);', 'return {};'],
  ['mcp/server.ts', 'a message without jsonrpc 2.0 is served', "if (!isObject(msg) || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') {", "if (!isObject(msg) || typeof msg['method'] !== 'string') {"],
  ['mcp/server.ts', 'a request with id null is answered', "if (!isId(id)) return failure(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number');", ''],
  ['mcp/server.ts', 'a line over the cap is held whole', '    if (buf.length > MAX_LINE) {', '    if (false) {'],
  ['mcp/server.ts', 'a log line on stdout', 'const server = createMcpServer(o);', "const server = createMcpServer(o);\n  output.write('skills-catalog mcp: serving\\n');"],
  // Not listed: 'the server closes before answering what is in flight' (dropping `await Promise.all(inFlight)`). It's
  // equivalent while the local catalog is synchronous: every call finishes before the end of input is even read. The
  // test that calls 20 tools and closes at once stays, for a catalog whose storage waits (the hosted one).
  ['operations.ts', 'a catalog that failed to open is never tried again', '        opened = undefined;\n', ''],
  // the words an assistant reads
  ['operations.ts', 'a bug\'s traceback reaches the assistant', ": renderError(surface, err), target: NONE, result: log.error(err.code) };", ": (err.code === 'internal_error' && e instanceof Error ? String(e.stack) : renderError(surface, err)), target: NONE, result: log.error(err.code) };"],
  ['operations.ts', 'errors don\'t say who you act as', 'return { text: settings.developer ?', 'return { text: settings.developer && !isError ?'],
  ['operations.ts', 'the acting line is data, not the surface\'s words', "s.format(s.word('acting_as'), { developer })", '`acting_as: ${developer}`'],
  ['operations.ts', 'a SKILLS_AS that isn\'t a developer name is ignored', 'if (settings.developerInvalid) throw', 'if (false) throw'],
  ['settings.ts', 'SKILLS_AS is taken whatever it holds', 'const valid = as !== undefined && ACTOR.test(as);', 'const valid = as !== undefined;'],
  ['operations.ts', 'a later page says it shows the first cards (the request isn\'t passed on)', 'renderSearch(ctx.surface, r, (args ?? {}) as SearchInput)', 'renderSearch(ctx.surface, r, {})'],
  ['operations.ts', 'every read\'s fence has the same token', 'renderRead(ctx.surface, r, ctx.ids)', "renderRead(ctx.surface, r, { next: () => 'fixed' })"],
  // the activity log
  ['operations.ts', 'the log\'s search target is the query', 'target: log.searchTarget(r.total_matches, r.catalog_size)', 'target: String((args as { query?: string } | undefined)?.query)'],
  ['operations.ts', 'the log\'s read target comes from the arguments', "target: items.map((i) => `${i.name} v${i.version}`).join(', ') || NONE", "target: String((args as { name?: string } | undefined)?.name ?? NONE)"],
  ['operations.ts', 'the log says a diff adds nothing that can run, whatever it adds', "r.risk_flags.length ? 'runnable' : 'text_only'", "'text_only'"],
  ['operations.ts', 'the log shows an error\'s code, not its words', 'result: log.error(err.code) };', 'result: err.code };'],
  ['activity.ts', 'the result column is narrower than its longest word', 'width: Math.max(...all.map((w) => w.length)),', 'width: 16,'],
  ['operations.ts', 'the log names a developer that isn\'t one', 'who: settings.developer, tool: name', "who: process.env['SKILLS_AS'], tool: name"],
  ['activity.ts', 'a link in the log\'s place is followed', ' | constants.O_NOFOLLOW', ''],
  ['activity.ts', 'a FIFO in the log\'s place stalls the server', ' | constants.O_NONBLOCK', ''],
  ['activity.ts', 'a special file in the log\'s place is written to', '      if (!st.isFile()) return;\n', ''],
  // Not listed: 'the log file is made readable by everyone' (creating it 0644). Equivalent: the next step tightens any
  // file looser than 0600, a guard of its own ('a log file made looser before stays loose').
  ['activity.ts', 'a log file made looser before stays loose', '      if ((st.mode & 0o077) !== 0) fchmodSync(fd, 0o600);\n', ''],
  ['activity.ts', 'the log\'s folder is made readable by everyone', 'mkdirSync(dir, { recursive: true, mode: 0o700 });', 'mkdirSync(dir, { recursive: true, mode: 0o755 });'],
  ['activity.ts', 'SKILLS_HOME made looser before stays loose', '(st.mode & 0o077) !== 0) chmodSync(dir, 0o700);', '(st.mode & 0o077) !== 0) void 0;'],
  ['activity.ts', 'a folder the person named is tightened too', '    if (o.ownFolder) {', '    if (true) {'],
  ['activity.ts', 'a log that can\'t be written fails the call', '  } catch {\n    // dropped', '  } finally {\n    // dropped'],
  ['activity.ts', 'the log\'s time is local, not UTC', 'a.at.toISOString().slice(11, 19)', 'a.at.toTimeString().slice(0, 8)'],
  ['activity.ts', 'the target comes before the result (a long one shifts the columns)', '${a.result.padEnd(resultWidth)}  ${a.target}', '${a.target.padEnd(26)}  ${a.result}'],
  ['settings.ts', 'SKILLS_ACTIVITY_LOG is ignored', "resolve(env['SKILLS_ACTIVITY_LOG'] || join(home, 'activity.log'))", "resolve(join(home, 'activity.log'))"],
  // publishing a folder over MCP (the MCP-level tests in publish.test.ts)
  ['mcp/server.ts', 'the MCP server asks as the CLI (an input only a person may give gets through)', "contextFor(o.settings, surface, 'mcp', o.now)", "contextFor(o.settings, surface, 'cli', o.now)"],
  ['operations.ts', 'no developer name on a local catalog says to run login', "const local = err.code === 'unauthenticated' && settings.catalog.startsWith('file:');", 'const local = false;'],
  // the folder is read as it was checked (publish-folder.test.ts). Taking out only O_NOFOLLOW is masked by the inode
  // check, and only the inode check by O_NOFOLLOW for a link: the "another regular file" and "hard link" swaps catch the
  // inode check on its own.
  ['machine/publish-folder.ts', 'a link in the folder is followed to its target', 'const st = lstatSync(full);', 'const st = lstatSync(realpathSync(full));'],
  ['machine/publish-folder.ts', 'the handle isn\'t checked against the file that was checked', 'if (!st.isFile() || st.nlink !== 1 || !same(st, checked)) notRegular(rel);', 'if (!st.isFile()) notRegular(rel);'],
  ['machine/publish-folder.ts', 'a fifo swapped in blocks the read', 'fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);', 'fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);'],
  ['machine/publish-folder.ts', 'a folder swapped for a link is listed', "if (!now.isDirectory() || !same(now, checked)) notRegular(rel || '.');", "if (false) notRegular(rel || '.');"],
  // the ignore list and the skipped list (golden hostile ignore-list, ignored-folders, skipped-cap)
  ['machine/publish-folder.ts', 'the ignore list is sent', 'if (ignored(e.name)) {', 'if (false) {'],
  ['machine/publish-folder.ts', 'an ignored folder is walked', 'if (ignored(e.name)) {', 'if (ignored(e.name) && !st.isDirectory()) {'],
  ['machine/publish-folder.ts', 'the skipped list has no cap', 'skipped.slice(0, SKIPPED_SHOWN)', 'skipped.slice(0)'],
  // step 2 (golden publish_steps and request_checks)
  ['machine/publish-folder.ts', 'step 2\'s values without a confirm are ignored', 'if (STEP2.some((k) => req[k] !== undefined)) throw', 'if (false) throw'],
  ['machine/publish-folder.ts', 'a malformed confirm is taken as one that changed', 'if (!CONFIRM_FORM.test(req.confirm)) throw', 'if (false) throw'],
  ['machine/publish-folder.ts', 'the confirm isn\'t checked', 'if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw', 'if (false) throw'],
  ['machine/publish-folder.ts', 'the flags are compared as a list, not a set', 'const kinds = (flags: readonly string[]) => [...new Set(flags)].sort(byCodePoint);', 'const kinds = (flags: readonly string[]) => [...flags];'],
  ['machine/publish-folder.ts', 'the confirm doesn\'t bind the message', 'b.latest, b.message, b.files', 'b.latest, null, b.files'],
  ['machine/publish-folder.ts', 'the confirm binds the path as given, not the real path', 'real = realpathSync(req.folder);', 'real = req.folder;'],
  ['machine/publish-folder.ts', 'a key with a wider mode is kept', '(st.mode & 0o777) === 0o600 && st.uid', '(st.mode & 0o700) === 0o600 && st.uid'],
  ['machine/publish-folder.ts', 'a link in the key\'s place is written through', 'renameSync(tmp, path); // replaces', 'writeFileSync(path, key); unlinkSync(tmp); // replaces'],
  // the person-only override: the face the caller gives, never a fixed one
  ['machine/publish-folder.ts', 'publish always checks as the CLI (the override gets through MCP)', "validateInput<Input>('publish_skill_to_catalog', args, ctx.face)", "validateInput<Input>('publish_skill_to_catalog', args, 'cli')"],
  ['machine/publish-folder.ts', 'publish always checks as MCP (the person\'s CLI override is refused)', "validateInput<Input>('publish_skill_to_catalog', args, ctx.face)", "validateInput<Input>('publish_skill_to_catalog', args, 'mcp')"],
  // the core's words for a command the person runs (golden command_quoting)
  ['core:render.ts', 'a folder in a command isn\'t shell-quoted', "{ folder: shellQuote(String(d['folder'])) }", "{ folder: String(d['folder']) }"],
  // the installer's folders (contract §4.5; installer-race.test.ts)
  ['machine/installer.ts', 'a folder others can write counts as private', '  if ((s.mode & 0o002n) !== 0n) return false;\n', ''],
  ['machine/installer.ts', 'a uid of 0 is read as no uid (root in a container)', '  if (uid === undefined) return true;', '  if (!uid) return true;'],
  ['machine/installer.ts', 'the folder above .claude isn\'t checked', "  if (open) throw notPrivate(root, target, r, target === 'user');\n", ''],
  ['machine/installer.ts', 'a folder on the way that can\'t be made is a failure of the tool', "      if (!UNMAKEABLE.has((e as NodeJS.ErrnoException).code ?? '')) throw e;", '      throw e;'],
  ['machine/installer.ts', 'a moved-aside folder is removed by its path alone', '  if (!isCopy(lstatOf(path), id)) return false;\n', ''],
  ['machine/installer.ts', 'staging isn\'t looked at again before its .gitignore', '    stagingThere();\n    try {', '    try {'],
  ['machine/installer.ts', 'a staging folder already there is checked only once the skills folder is made', '  if (existsSync(early)) realFolder(early, target);\n', ''],
  ['machine/installer.ts', 'staging isn\'t looked at again before the temp folder is made', '  stagingThere();\n  const tmp', '  const tmp'],
  ['machine/installer.ts', 'a .gitignore already in a new staging folder is a failure of the tool', "      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;\n      failed ??= stagingDir;", '      throw e;\n      failed ??= stagingDir;'],
  // installing over an installed copy (held-table.test.ts)
  ['machine/installer.ts', 'the same version from another catalog replaces the installed copy', 'const otherCatalog = existing !== undefined && existing.catalog !== ctx.settings.catalog;', 'const otherCatalog = false;'],
  ['machine/installer.ts', 'a held copy from another catalog at the same version isn\'t found by --accept', 'e.catalog === ctx.settings.catalog) return { installed: e.version };', 'true) return { installed: e.version };'],
  // one writer at a time (lock-race.test.ts)
  ['machine/lock.ts', 'a holder\'s start is read as a local time', "['-o', 'etime=', '-p', String(pid)]", "['-o', 'lstart=', '-p', String(pid)]"],
  ['machine/lock.ts', 'a live holder is taken for a stale one', "    if ((e as NodeJS.ErrnoException).code === 'ESRCH') return true;", '    return true;'],
];

// A mutant is caught by its first failing test, so mutant runs stop there (--bail 1); the baseline runs everything.
function run(bail = false) {
  const tmp = mkdtempSync(join(tmpdir(), 'client-mutate-'));
  try {
    return spawnSync('npx', ['vitest', 'run', ...(bail ? ['--bail', '1'] : [])], { encoding: 'utf8', cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, TMPDIR: tmp } });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
const failed = (r) => r.stdout.split('\n').filter((l) => l.trim().startsWith('×')).map((l) => l.trim().replace(/ \d+ms$/, ''));

const baseline = run();
if (baseline.status !== 0 || failed(baseline).length) {
  console.log(`the suite is red before any mutation; fix it first:\n  ${failed(baseline).join('\n  ') || baseline.stderr.slice(-2000)}`);
  process.exit(2);
}
console.log('baseline: the suite is green');

const only = process.argv[2];
const chosen = MUTATIONS.filter(([file, name]) => !only || file.includes(only) || name.includes(only));
let missed = 0;
for (const [file, name, from, to] of chosen) {
  const original = readFileSync(src(file), 'utf8');
  if (!original.includes(from)) { console.log(`STALE   ${name}: its code is gone; update this list`); missed++; continue; }
  try {
    writeFileSync(src(file), original.replace(from, to));
    const r = run(true);
    const f = failed(r);
    const caught = f.length > 0 || r.status !== 0;
    console.log(`${caught ? 'CAUGHT ' : 'MISSED '} ${name}${f.length ? `\n          by: ${f[0]}` : caught ? '\n          by: the suite failing to run' : ''}`);
    if (!caught) missed++;
  } finally {
    writeFileSync(src(file), original);
  }
}
console.log(missed ? `${missed} mutation(s) not caught` : `all ${chosen.length} mutations caught${only ? ` (of those matching "${only}")` : ''}`);
process.exit(missed ? 1 : 0);
