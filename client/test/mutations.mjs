// Mutation check for the client: each mutation puts back a bug the tests are there to catch, and the tests must fail
// for every one. `npm run mutate` from client/ (`npm run mutate -- <text>` runs only the matching ones). The suite runs
// once first and nothing is mutated unless it is green. Files are edited in place and always restored, so never
// commit while it runs. Safe: every test's server runs with SKILLS_HOME, the catalog and HOME in a sandbox folder.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const src = (f) => new URL(`../src/${f}`, import.meta.url);
const MUTATIONS = [
  // the protocol
  ['mcp/server.ts', 'a notification gets a reply', "if (!('id' in msg)) return undefined;", "if (!('id' in msg)) return reply(null, {});"],
  ['mcp/server.ts', 'any protocol version the client asks for is echoed', 'PROTOCOL_VERSIONS.find((v) => v === asked) ?? PROTOCOL_VERSIONS[0]', "(typeof asked === 'string' ? asked : PROTOCOL_VERSIONS[0])"],
  ['mcp/server.ts', 'an unknown tool is a tool result, not -32602', 'if (!def) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params[\'name\']}`);', "if (!def) return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };"],
  ['mcp/server.ts', 'an unknown method is answered', 'throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);', 'return {};'],
  ['mcp/server.ts', 'a message without jsonrpc 2.0 is served', "if (!isObject(msg) || msg['jsonrpc'] !== '2.0' || typeof msg['method'] !== 'string') {", "if (!isObject(msg) || typeof msg['method'] !== 'string') {"],
  ['mcp/server.ts', 'a log line on stdout', 'const server = createMcpServer(o);', "const server = createMcpServer(o);\n  output.write('skills-catalog mcp: serving\\n');"],
  // Not listed: 'the server closes before answering what is in flight' (dropping `await Promise.all(inFlight)`). It's
  // equivalent while the local catalog is synchronous: every call finishes before the end of input is even read. The
  // test that calls 20 tools and closes at once stays, for a catalog whose storage waits (the hosted one).
  ['mcp/server.ts', 'a catalog that failed to open is never tried again', '      opened = undefined;\n', ''],
  // the words an assistant reads
  ['mcp/server.ts', 'a bug\'s traceback reaches the assistant', 'done = { text: renderError(surface, err), target:', "done = { text: err.code === 'internal_error' && e instanceof Error ? String(e.stack) : renderError(surface, err), target:"],
  ['mcp/server.ts', 'errors don\'t say who you act as', 'const text = settings.developer ?', 'const text = settings.developer && !isError ?'],
  ['mcp/server.ts', 'a SKILLS_AS that isn\'t a developer name is ignored', 'if (settings.developerInvalid) throw', 'if (false) throw'],
  ['settings.ts', 'SKILLS_AS is taken whatever it holds', 'const valid = as !== undefined && DEVELOPER.test(as);', 'const valid = as !== undefined;'],
  ['mcp/tools.ts', 'a later page says it shows the first cards', "offsetOf(field(args, 'cursor'))", '0'],
  ['mcp/tools.ts', 'a read of an older version shows the latest SKILL.md', 'c.fetch({ name: i.name, version: i.version })', 'c.fetch({ name: i.name, version: i.latest_version })'],
  // the activity log
  ['mcp/tools.ts', 'the log\'s search target is the query', 'target: `${r.total_matches}/${r.catalog_size}`', "target: String(field(args, 'query'))"],
  ['mcp/tools.ts', 'the log\'s read target comes from the arguments', "const target = items.map((i) => `${i.name} v${i.version}`).join(', ') || NONE;", "const target = String(field(args, 'name') ?? NONE);"],
  ['mcp/server.ts', 'the log names a developer that isn\'t one', 'who: settings.developer, tool: def.name', "who: process.env['SKILLS_AS'], tool: def.name"],
  ['activity.ts', 'a link in the log\'s place is followed', ' | constants.O_NOFOLLOW', ''],
  ['activity.ts', 'the log file is readable by everyone', 'constants.O_NOFOLLOW, 0o600)', 'constants.O_NOFOLLOW, 0o644)'],
  ['activity.ts', 'the log\'s folder is readable by everyone', 'mkdirSync(dirname(path), { recursive: true, mode: 0o700 });', 'mkdirSync(dirname(path), { recursive: true, mode: 0o755 });'],
  ['activity.ts', 'a log that can\'t be written fails the call', '  } catch {\n    // dropped', '  } finally {\n    // dropped'],
  ['activity.ts', 'the log\'s time is local, not UTC', 'a.at.toISOString().slice(11, 19)', 'a.at.toTimeString().slice(0, 8)'],
  ['settings.ts', 'SKILLS_ACTIVITY_LOG is ignored', "resolve(env['SKILLS_ACTIVITY_LOG'] || join(home, 'activity.log'))", "resolve(join(home, 'activity.log'))"],
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
