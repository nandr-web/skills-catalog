// The API's definitions (contract §1, §1.1, §9): each operation's row says where it's served, what it changes, what it
// returns and which code runs it; the error list is data at run time and is §9's. The tables below are the approved API
// page's (docs/api.md), pinned here so a row can't drift from it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OPERATIONS, inputSchema, validateInput, webRow, type OperationDef, type OutputSchema, type Where } from '../src/api.ts';
import { Catalog } from '../src/catalog.ts';
import { COMMON_ERRORS, CatalogError, ERROR_CODES } from '../src/errors.ts';
import { openapi } from '../src/openapi.ts';
import { WORD_GAPS, renderError } from '../src/render.ts';
import { Words } from '../src/words-file.ts';
import { actAs } from '../src/local/index.ts';
import { filesOf, historyVersion, loadGolden } from './golden.ts';
import { conforms } from './conforms.ts';
import { errorOf, openTest, request } from './helpers.ts';
import { openHostedStandIn, sha256Of } from './hosted-stand-in.ts';

const histories = loadGolden('histories.yaml');
const skills = loadGolden('skills.yaml');

// Contract §1.1: served as the web face, a person-only input (cliOnly, e.g. the secret override) is invalid_request
// {unknown_field}. The Catalog checks its input as the face its caller gives; one that gives none gets no person-only
// input either.
describe('the secret override is a person\'s only, through the Catalog too (contract §1.1)', () => {
  it('publish_version refuses it as the web face and by default, still refuses the secret, and takes it from the CLI', async () => {
    const { catalog } = await openTest();
    const secret = filesOf(skills.hostile['secret-in-body'].files)!;
    const allow = request('secret-in-body', secret, { allow_suspected_secrets: true });
    expect('allow_suspected_secrets' in inputSchema('publish_version', 'web', 'local').properties).toBe(false);
    for (const face of ['web', undefined] as const) {
      expect((await errorOf(() => catalog.publish(allow, actAs('dev1'), face))).toJSON()).toMatchObject({ code: 'invalid_request', field: 'allow_suspected_secrets', why: 'unknown_field' });
    }
    expect((await errorOf(() => catalog.publish(request('secret-in-body', secret), actAs('dev1'), 'web'))).toJSON()).toMatchObject({ code: 'secret_suspected', path: 'SKILL.md' });
    expect(await catalog.publish(allow, actAs('dev1'), 'cli')).toMatchObject({ created: true, version: 1 });
    // every catalog operation takes its caller's face
    expect((await catalog.search({ query: 'secret' }, 'web')).total_matches).toBe(1);
    expect((await catalog.fetch({ name: 'secret-in-body', version: 1 }, 'web')).version).toBe(1);
    catalog.close();
  });
});

const FACES: Record<string, readonly string[]> = {
  search_shared_skills: ['mcp', 'cli', 'web'],
  read_shared_skill: ['mcp', 'cli', 'web'],
  list_shared_skill_versions: ['mcp', 'cli', 'web'],
  diff_shared_skill_versions: ['mcp', 'cli', 'web'],
  publish_version: ['web'],
  fetch_version: ['web'],
  request_upload_links: ['web'], // hosted only
  publish_skill_to_catalog: ['mcp'], // its CLI command is on a branch
  install_shared_skill: ['mcp', 'cli'],
  update_installed_skills: ['mcp', 'cli'],
  accept_held_update: ['mcp', 'cli'],
  list_installed_skills: ['mcp', 'cli'],
  set_skill_update_policy: ['mcp', 'cli'],
};
const EFFECT: Record<string, string> = {
  search_shared_skills: 'reads',
  read_shared_skill: 'reads',
  list_shared_skill_versions: 'reads',
  diff_shared_skill_versions: 'reads',
  publish_version: 'writes_catalog',
  fetch_version: 'reads',
  request_upload_links: 'writes_catalog', // it claims each stored file it's asked about
  publish_skill_to_catalog: 'writes_catalog',
  install_shared_skill: 'writes_machine',
  update_installed_skills: 'writes_machine',
  accept_held_update: 'writes_machine',
  list_installed_skills: 'reads',
  set_skill_update_policy: 'writes_machine',
};
// A catalog row names the Catalog method; a machine row, its function in the client's machine operations (resolved there).
const RUN: Record<string, string> = {
  search_shared_skills: 'search',
  read_shared_skill: 'read',
  list_shared_skill_versions: 'versions',
  diff_shared_skill_versions: 'diff',
  publish_version: 'publish',
  fetch_version: 'fetch',
  request_upload_links: 'uploadLinks',
  publish_skill_to_catalog: 'publishFolder',
  install_shared_skill: 'install',
  update_installed_skills: 'update',
  accept_held_update: 'accept',
  list_installed_skills: 'list',
  set_skill_update_policy: 'setPolicy',
};

describe('each operation\'s definition (contract §1)', () => {
  it('says where it\'s served: the approved faces, and the web face serves catalog operations only', () => {
    expect(Object.keys(OPERATIONS).sort()).toEqual(Object.keys(FACES).sort());
    for (const [op, def] of Object.entries(OPERATIONS)) {
      expect([op, def.faces]).toEqual([op, FACES[op]]);
      if (def.kind === 'machine') expect([op, def.faces.includes('web')]).toEqual([op, false]);
    }
  });

  it('the assistant\'s tools are exactly the operations with the mcp face', () => {
    const tools = Words.load().toolDefs().map((t) => t.op).sort();
    expect(tools).toEqual(Object.values(OPERATIONS).filter((o) => o.faces.includes('mcp')).map((o) => o.name).sort());
    // An operation with words but no mcp face (every row today that has words is an MCP one) gets no tool.
    const cliOnlyOp = { ...OPERATIONS['search_shared_skills']!, name: 'probe', faces: ['cli', 'web'] as const };
    expect(Words.load().toolDefs({ probe: cliOnlyOp })).toEqual([]);
    expect(Words.load().toolDefs({ probe: { ...cliOnlyOp, faces: ['mcp'] } }).map((t) => t.op)).toEqual(['probe']);
  });

  it('says what it changes: it reads, writes the catalog, or writes this machine', () => {
    for (const [op, def] of Object.entries(OPERATIONS)) expect([op, def.effect]).toEqual([op, EFFECT[op]]);
  });

  it('names the code that runs it: a catalog row, a Catalog method', () => {
    for (const [op, def] of Object.entries(OPERATIONS)) {
      expect([op, def.run]).toEqual([op, RUN[op]]);
      if (def.kind === 'catalog') expect([op, typeof (Catalog.prototype as unknown as Record<string, unknown>)[def.run]]).toEqual([op, 'function']);
    }
  });

  it('the web face never gets an input only a person may give', () => {
    for (const def of Object.values(OPERATIONS)) {
      for (const k of def.cliOnly ?? []) expect([def.name, k in inputSchema(def, 'web', 'local').properties]).toEqual([def.name, false]);
    }
    const e = (() => {
      try {
        validateInput('install_shared_skill', { name: 'x', policy: 'pin' }, 'web', 'local');
      } catch (err) {
        return err as CatalogError;
      }
    })();
    expect(e?.toJSON()).toMatchObject({ code: 'invalid_request', field: 'policy', why: 'unknown_field' });
  });

  // §9: an unknown key longer than 200 characters is named by its first 200 whole characters, with field_cut: true, so
  // an answer never grows with the key a request sent, and the sentence names the same cut field.
  it('names an unknown key by at most its first 200 whole characters, and says when it cut one', () => {
    const refused = (input: unknown) => {
      try {
        validateInput('search_shared_skills', input, 'web', 'local');
      } catch (err) {
        return err as CatalogError;
      }
      throw new Error('not refused');
    };
    const refusal = (input: unknown) => refused(input).toJSON() as Record<string, unknown>;
    const huge = refusal({ ['k'.repeat(1_000_000)]: 1 });
    expect(huge).toMatchObject({ code: 'invalid_request', field: 'k'.repeat(200), why: 'unknown_field', field_cut: true });
    expect(JSON.stringify(huge).length).toBeLessThan(1000);
    const astral = '😀'.repeat(199) + 'ab';
    const cut = refusal({ [astral]: 1 });
    expect(cut).toMatchObject({ field: '😀'.repeat(199) + 'a', field_cut: true });
    expect([...(cut.field as string)].length).toBe(200);
    expect(refusal({ ['😀'.repeat(200)]: 1 })).toMatchObject({ field: '😀'.repeat(200) });
    expect('field_cut' in refusal({ ['k'.repeat(200)]: 1 })).toBe(false);
    expect(refusal({ ['k'.repeat(200)]: 1 }).field).toBe('k'.repeat(200));
    expect(refusal({ ['k'.repeat(201)]: 1 })).toMatchObject({ field: 'k'.repeat(200), field_cut: true });
    expect(refusal({ filters: { ['o'.repeat(300)]: 1 } })).toMatchObject({ field: `filters.${'o'.repeat(200)}`, why: 'unknown_field', field_cut: true });
    expect('field_cut' in refusal({ filters: { owner: 1 } })).toBe(false);
    const sentence = renderError(Words.load(), refused({ ['k'.repeat(1_000_000)]: 1 }));
    expect(sentence).toContain('k'.repeat(200));
    expect(sentence).not.toContain('k'.repeat(201));
  });

  // One rule for which rows the HTTP API serves where the catalog runs, read by the published schema and the server alike.
  it('the HTTP API serves a row with the web face that isn\'t only for the other place', () => {
    const search = OPERATIONS['search_shared_skills']!;
    const probes: Record<string, OperationDef> = {
      web_any: { ...search, name: 'web_any' },
      web_hosted: { ...search, name: 'web_hosted', where: 'hosted' },
      no_web: { ...search, name: 'no_web', faces: ['mcp', 'cli'] },
      no_web_hosted: { ...search, name: 'no_web_hosted', faces: ['cli'], where: 'hosted' },
    };
    const served = (where: Where) => Object.values(probes).filter((d) => webRow(d, where)).map((d) => d.name);
    expect(served('local')).toEqual(['web_any']);
    expect(served('hosted')).toEqual(['web_any', 'web_hosted']);
    // By name, as a route reads it from a URL: only the table's own keys are operations.
    expect(webRow('search_shared_skills', 'local')).toBe(true);
    for (const name of ['__proto__', 'toString', 'constructor', 'hasOwnProperty', 'nope', '']) expect([name, webRow(name, 'hosted')]).toEqual([name, false]);
    for (const where of ['local', 'hosted'] as const) {
      const routes = Object.keys(openapi(where, { ...OPERATIONS, ...probes }).paths as Record<string, unknown>)
        .filter((p) => !p.includes('{'))
        .map((p) => p.slice(p.lastIndexOf('/') + 1))
        .sort();
      expect([where, routes]).toEqual([where, Object.values({ ...OPERATIONS, ...probes }).filter((d) => webRow(d, where)).map((d) => d.name).sort()]);
    }
  });
});

// §9: "The list is data, not only a type: the API exports it at run time [...] and a test fails when this section and
// the code's list differ." The section's codes are the backticked names in its list of errors, outside any {…} or (…).
function contractCodes(): string[] {
  const text = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'contract.md'), 'utf8');
  const s9 = text.slice(text.indexOf('## 9. Error codes'), text.indexOf('## 10.'));
  let list = s9.slice(s9.indexOf('`internal_error` {log}'), s9.indexOf('Each error carries'));
  for (let prev = ''; prev !== list; ) [prev, list] = [list, list.replace(/\{[^{}]*\}/g, '').replace(/\([^()]*\)/g, '')];
  return [...list.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!);
}

describe('the error list at run time (contract §9)', () => {
  it('is the contract\'s list, in its order', () => {
    const codes = contractCodes();
    expect(codes.length).toBeGreaterThan(20);
    expect([...ERROR_CODES]).toEqual(codes);
  });

  // A code added anywhere else in §9 (a table, a later sentence) must be in the list too: every other backticked word
  // there, outside an error's {fields}, is a why the words file has a sentence for (or one asked for: WORD_GAPS), or one
  // of these. Text in (…) is read too, so a code can't hide in an aside.
  const NOT_CODES: Record<string, string> = {
    problem: 'a field of invalid_manifest',
    why: 'a field of invalid_request and others',
    safe_frontmatter_keys: 'a setup config key',
    non_granting_keys: 'a setup config key',
    person_only: 'a CLI outcome (exit 3), never an error',
    cursor: 'a search or versions input',
    expected_fingerprint: 'a publish_version input',
    limit: 'a search input, and a field of invalid_request',
    me: 'a setup config key',
    serve: 'a CLI command, whose server a refusal names',
    // Seen since the check reads names with digits (not_sha256 was missed before):
    '200': 'an HTTP status (an answer in the envelope)',
    content_base64: 'a publish_version input (a file inline)',
  };
  it('names no code outside its list: every other word it marks as code is a why with a sentence, or a named field or outcome', () => {
    const text = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'contract.md'), 'utf8');
    let s9 = text.slice(text.indexOf('## 9. Error codes'), text.indexOf('## 10.'));
    for (let prev = ''; prev !== s9; ) [prev, s9] = [s9, s9.replace(/\{[^{}]*\}/g, '')];
    const marked = new Set([...s9.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]!));
    const gaps = WORD_GAPS.filter((k) => k.startsWith('errors.why.')).map((k) => k.slice('errors.why.'.length));
    const whys = [...Object.keys(Words.load().word('errors.why') as Record<string, string>), ...gaps];
    const known = new Set<string>([...ERROR_CODES, ...whys, ...Object.keys(NOT_CODES)]);
    expect([...marked].filter((w) => !known.has(w)).sort()).toEqual([]);
    for (const w of Object.keys(NOT_CODES)) expect([w, marked.has(w), (ERROR_CODES as readonly string[]).includes(w) || whys.includes(w)]).toEqual([w, true, false]);
  });

  it('a CatalogError takes only a listed code, and any call may return the common four', () => {
    expect([...COMMON_ERRORS]).toEqual(['invalid_request', 'invalid_developer_setting', 'internal_error', 'forbidden']);
    for (const c of COMMON_ERRORS) expect(ERROR_CODES).toContain(c);
    for (const c of ERROR_CODES) expect(new CatalogError(c).code).toBe(c);
  });
});

describe('each operation\'s output (contract §1)', () => {
  it('a catalog operation\'s is a schema; a machine operation\'s is text, for now', () => {
    for (const def of Object.values(OPERATIONS)) {
      if (def.kind === 'machine') expect([def.name, def.output]).toEqual([def.name, 'text']);
      else expect([def.name, typeof def.output === 'object' && 'type' in def.output && def.output.type]).toEqual([def.name, 'object']);
    }
  });

  it('every object in an output schema says whether it takes other fields: closed, but for a front matter and an error\'s data', () => {
    const open: string[] = [];
    const walk = (s: OutputSchema, at: string): void => {
      if ('anyOf' in s) return s.anyOf.forEach((x, i) => walk(x, `${at}|${i}`));
      if (!('type' in s)) return;
      if (s.type === 'array') return walk(s.items, `${at}[]`);
      if (s.type !== 'object') return;
      if (s.additionalProperties === undefined) open.push(`${at}: not said`);
      else if (s.additionalProperties !== false) open.push(at);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${at}.${k}`);
    };
    for (const def of Object.values(OPERATIONS)) if (def.output !== 'text') walk(def.output, def.name);
    // An upload link's headers are named by the link's issuer (the storage's own), so any header name goes.
    expect(open).toEqual(['read_shared_skill.skills[]|0.manifest.frontmatter', 'read_shared_skill.skills[]|1.error', 'request_upload_links.files[]|0.headers']);
  });

  it('what each catalog operation really returns fits its schema, every shape it takes', async () => {
    const { catalog } = await openTest();
    const v = (ref: string) => historyVersion(histories.versions[ref]);
    const out = (op: string) => OPERATIONS[op]!.output as OutputSchema;
    const seen: [string, unknown][] = [];
    const run = async (op: string, call: () => Promise<unknown>) => {
      const r = await call();
      seen.push([op, r]);
      return r;
    };
    // publish: new, dry run (with a diff), identical, and a new version with flags
    await run('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v1'), { message: 'first' }), actAs('dev1')));
    await run('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v3'), { dry_run: true }), actAs('dev1')));
    await run('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v1')), actAs('dev1')));
    await run('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v2')), actAs('dev1')));
    await run('publish_version', () => catalog.publish(request('pr-review-checklist', v('prc.v3'), { expected_latest: 2 }), actAs('dev1')));
    // search: all, partial, none, and a page with a cursor
    await run('search_shared_skills', () => catalog.search({ query: 'review checklist' }));
    await run('search_shared_skills', () => catalog.search({ query: 'review zebra' }));
    await run('search_shared_skills', () => catalog.search({ query: 'zebra' }));
    await run('search_shared_skills', () => catalog.search({}));
    // read: each include, several names with one missing, paths, an older version
    for (const include of ['manifest', 'files', 'contents'] as const) await run('read_shared_skill', () => catalog.read({ name: 'pr-review-checklist', include }));
    await run('read_shared_skill', () => catalog.read({ names: ['pr-review-checklist', 'no-such-skill'] }));
    await run('read_shared_skill', () => catalog.read({ name: 'pr-review-checklist', paths: ['SKILL.md'] }));
    await run('read_shared_skill', () => catalog.read({ name: 'pr-review-checklist', version: 1, include: 'contents' }));
    await run('list_shared_skill_versions', () => catalog.versions({ name: 'pr-review-checklist' }));
    await run('diff_shared_skill_versions', () => catalog.diff({ name: 'pr-review-checklist', from: 1, to: 3 }));
    await run('diff_shared_skill_versions', () => catalog.diff({ name: 'pr-review-checklist', from: 2, to: 3 }));
    const fetched = (await run('fetch_version', () => catalog.fetch({ name: 'pr-review-checklist', version: 3 }))) as { fingerprint: string };
    await run('fetch_version', () => catalog.fetch({ fingerprint: fetched.fingerprint }));
    catalog.close();
    for (const [op, r] of seen) expect([op, conforms(out(op), r)]).toEqual([op, []]);

    // hosted: the upload links' three answers, a publish by sha256, and a fetch's links, against the hosted schemas
    const hosted = await openHostedStandIn({ removing: { [sha256Of('going')]: '2026-09-28T13:00:00.000Z' } });
    const hostedOut = (op: string) => OPERATIONS[op]!.hostedOutput ?? out(op);
    const seenHosted: [string, unknown][] = [];
    const md = '---\nname: up\ndescription: Uploaded.\n---\nBody.\n';
    const have = hosted.upload(md);
    seenHosted.push(['request_upload_links', await hosted.catalog.uploadLinks({ name: 'up', files: [{ sha256: sha256Of('new'), size: 3 }, { sha256: have, size: md.length }, { sha256: sha256Of('going'), size: 5 }] })]);
    seenHosted.push(['publish_version', await hosted.catalog.publish({ name: 'up', files: [{ path: 'SKILL.md', mode: '0644', sha256: have }] })]);
    seenHosted.push(['fetch_version', await hosted.catalog.fetch({ name: 'up', version: 1 })]);
    hosted.close();
    expect((seenHosted[0]![1] as { files: { kind: string }[] }).files.map((f) => f.kind)).toEqual(['upload', 'stored', 'removing']);
    for (const [op, r] of seenHosted) expect([op, conforms(hostedOut(op), r)]).toEqual([op, []]);
    // the local fetch's answer isn't the hosted one's, nor the other way round
    expect(conforms(hostedOut('fetch_version'), fetched)).not.toEqual([]);
    expect(conforms(out('fetch_version'), seenHosted[2]![1])).not.toEqual([]);

    expect(new Set([...seen, ...seenHosted].map(([op]) => op))).toEqual(new Set(Object.values(OPERATIONS).filter((o) => o.kind === 'catalog').map((o) => o.name)));
    // and the check itself: a field the schema doesn't list, or a missing one, fails
    const [, one] = seen.find(([op]) => op === 'fetch_version')!;
    expect(conforms(out('fetch_version'), { ...(one as object), extra: 1 })).toEqual(['$.extra: not in the schema']);
    const { name: _, ...noName } = one as Record<string, unknown>;
    expect(conforms(out('fetch_version'), noName)).toEqual(['$.name: missing']);
  });
});
