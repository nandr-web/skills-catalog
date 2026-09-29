// Mutation check for the client: each mutation puts back a bug the tests are there to catch, and the tests must fail
// for every one. `npm run mutate` from client/ (`npm run mutate -- <text>` runs only the matching ones). The suite runs
// once first and nothing is mutated unless it is green. Files are edited in place and always restored, so never
// commit while it runs. Safe: every test's server runs with SKILLS_HOME, the catalog and HOME in a sandbox folder, and
// each run gets a temp folder of its own (TMPDIR), removed after it, so a run stopped at its first failure leaves nothing.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const src = (f) => new URL(`../src/${f}`, import.meta.url);
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
  ['machine/publish-folder.ts', 'a link in the folder is followed to its target', "import { lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';", "import { statSync as lstatSync, readdirSync, readFileSync, type Stats } from 'node:fs';"],
  ['machine/publish-folder.ts', 'the ignore list is sent', 'if (ignoredFile(e.name)) skipped.push(r);', 'if (false) skipped.push(r);'],
  ['machine/publish-folder.ts', 'the confirm isn\'t tied to the folder and the skill', 'if (t.name !== name || t.fingerprint !== fp) throw', 'if (false) throw'],
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
