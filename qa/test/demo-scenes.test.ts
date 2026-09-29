// The one-click demo's scenes and pane programs: the scene file validates; the stand-in assistant,
// driven through every step on a real catalog, prints every string the scene file expects (so the file can't promise
// words the product doesn't say); activity.log's columns and what never goes in it; the steps view's render and keys.
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { actAs, CatalogError, openLocalCatalog, Surface, type Catalog } from '../../core/src/index.ts';
import { answer, coreBackend, logLine, logWords, RESULT_WIDTH, type Backend, type Stage, wrap } from '../src/demo/assistant.ts';
import { CLI_OPS, loadScenes, parseScenes, SCENES_FILE, ScenesError, SKILLS_DIR, type Scenes } from '../src/demo/scenes.ts';
import { keyCommand, renderSteps, type StepsState } from '../src/demo/steps-view.ts';
import { cleanup, scratch } from './machine.ts';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, '');
/** What the product said in a pane: the lines behind the gutter, without it (the stand-in's own lines are left out). */
const productWords = (pane: string) => plain(pane).split('\n').filter((l) => l.startsWith('  │ ')).map((l) => l.slice(4)).join('\n');
const surface = Surface.load();
const opened: Catalog[] = [];
afterEach(() => { for (const c of opened.splice(0)) c.close(); cleanup(); });

/** A sandbox-like folder: each developer's skills copied to work/<who>/skills, and demo/, as the director does. */
function sandbox(scenes: Scenes, from = SKILLS_DIR) {
  const root = scratch('qa-demo-');
  for (const d of scenes.developers) for (const f of d.skills) cpSync(join(from, f), join(root, 'work', d.id, 'skills', f), { recursive: true });
  mkdirSync(join(root, 'demo'));   // the pane programs only add to files in it
  return root;
}

/** One stage per developer, each with its own catalog on the same folder (two processes, as in the demo). */
async function stages(scenes: Scenes, root: string, now = () => new Date()) {
  const panes: Record<string, string> = {};
  const out: Record<string, Stage> = {};
  const catalogs: Record<string, Catalog> = {};
  for (const d of scenes.developers) {
    const catalog = await openLocalCatalog(join(root, 'catalog'), { identity: actAs(d.id) });
    opened.push(catalog);
    catalogs[d.id] = catalog;
    panes[d.id] = '';
    const backend = coreBackend({ catalog, surface, skillsDir: join(root, 'work', d.id, 'skills') });
    out[d.id] = { who: d.id, scenes, backend, surface, out: (s) => { panes[d.id] += s; }, demoDir: join(root, 'demo'), pace: 0, now };
  }
  return { stages: out, panes, catalogs };
}

async function playAll(scenes: Scenes, root: string, now?: () => Date) {
  const { stages: st, panes } = await stages(scenes, root, now);
  const turns = [];
  for (const step of scenes.steps) for (const ask of step.asks) turns.push(await answer(st[ask.who]!, ask.say));
  const log = readFileSync(join(root, 'demo', 'activity.log'), 'utf8');
  return { panes, turns, log, turnsFile: readFileSync(join(root, 'demo', 'turns.jsonl'), 'utf8') };
}

const doc = () => JSON.parse(JSON.stringify(loadScenes(SCENES_FILE))) as any;
const refused = (d: unknown) => { try { parseScenes(d); return ''; } catch (e) { if (!(e instanceof ScenesError)) throw e; return e.message; } };

describe('scenes.yaml', () => {
  it('validates: two developers, eight steps in order, every folder there', () => {
    const s = loadScenes(SCENES_FILE);
    expect(s.developers.map((d) => d.id)).toEqual(['ana', 'bob']);
    expect(s.steps.map((x) => x.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const d of s.developers) for (const f of d.skills) expect(existsSync(join(SKILLS_DIR, f, 'SKILL.md')), f).toBe(true);
  });

  it('refuses a broken scene file, with the reason', () => {
    const cases: [string, (d: any) => void, RegExp][] = [
      ['an unknown who', (d) => { d.steps[1].asks[0].who = 'carol'; }, /step 2, ask 1: who "carol" is not a developer/],
      ['an unknown op', (d) => { d.steps[1].asks[0].calls[0].op = 'publsh'; }, /step 2, ask 1, call 1: unknown op "publsh"/],
      ['an unknown planned op', (d) => { d.steps[0].asks[0].calls[0].planned = 'instal'; }, /step 1, ask 1, call 1: unknown planned op "instal"/],
      ['a planned call without why', (d) => { delete d.steps[0].asks[0].calls[0].why; }, /step 1, ask 1, call 1: a planned call needs why/],
      ['a missing field', (d) => { delete d.steps[4].asks[0].calls[1].to; }, /step 5, ask 1, call 2: diff needs to/],
      ['a folder that isn\'t there', (d) => { d.developers[0].skills.push('nope'); }, /developer ana: no skill folder nope/],
      ['a folder the developer doesn\'t have', (d) => { d.steps[5].asks[0].calls[0].folder = 'release-note-draft-v2'; }, /step 6, ask 1, call 1: bob has no folder release-note-draft-v2/],
      ['a step without see', (d) => { delete d.steps[2].see; }, /step 3: no see/],
      ['expect naming an unknown pane', (d) => { d.steps[1].expect.carol = ['x']; }, /step 2: expect names carol/],
      ['an empty expect string', (d) => { d.steps[1].expect.log = ['']; }, /step 2: expect log/],
      // it would show ✓ with nothing checked; a step of planned calls only (1, 8) needs none
      ['a step that calls the catalog and expects nothing', (d) => { delete d.steps[1].expect; }, /step 2: it calls the catalog, so it needs expect/],
      ['an expect with no panes', (d) => { d.steps[4].expect = {}; }, /step 5: it calls the catalog, so it needs expect/],
      ['a command-line step with nothing to show on the server', (d) => { delete d.steps[7].expect_server; }, /step 8: it runs the command line, so it needs expect_server/],
      ['the same ask twice for one developer', (d) => { d.steps[6].asks[0].say = d.steps[5].asks[0].say; }, /step 7, ask 1: bob already asks "publish my fix to release-note-draft" in step 6/],
      ['a repeated step id', (d) => { d.steps[2].id = 2; }, /step 2 appears twice/],
      ['a stray key (a typo skips a check)', (d) => { d.steps[1].expcet = d.steps[1].expect; }, /step 2: unknown key expcet/],
      ['no steps', (d) => { d.steps = []; }, /no steps/],
      // a developer id names a pane and a folder: a short plain word, never a path or a pane the window has
      ['a developer id that is a path', (d) => { d.developers[1].id = '../bob'; }, /developer \.\.\/bob: id must be/],
      ['a developer id with capitals', (d) => { d.developers[0].id = 'Ana'; }, /developer Ana: id must be/],
      ['a developer id over 16 characters', (d) => { d.developers[0].id = 'a'.repeat(17); }, /developer a{17}: id must be/],
      ['a developer id the log pane has', (d) => { d.developers[1].id = 'log'; }, /developer log: id must be/],
      ['a developer id the steps pane has', (d) => { d.developers[1].id = 'steps'; }, /developer steps: id must be/],
    ];
    for (const [what, change, reason] of cases) {
      const d = doc();
      change(d);
      expect(refused(d), what).toMatch(reason);
    }
    expect(refused(doc())).toBe('');
  });

  it('refuses a skill folder that is a link (only real folders are copied into the sandbox)', () => {
    const skills = scratch('qa-demo-skills-');
    for (const f of ['release-note-draft-v2', 'sql-migrations', 'release-note-draft-bob']) cpSync(join(SKILLS_DIR, f), join(skills, f), { recursive: true });
    symlinkSync(join(SKILLS_DIR, 'release-note-draft-v1'), join(skills, 'release-note-draft-v1'));
    expect(() => parseScenes(doc(), skills)).toThrow(/developer ana: skill folder release-note-draft-v1 is a link/);
    unlinkSync(join(skills, 'release-note-draft-v1'));
    cpSync(join(SKILLS_DIR, 'release-note-draft-v1'), join(skills, 'release-note-draft-v1'), { recursive: true });
    expect(parseScenes(doc(), skills).developers).toHaveLength(2);
  });

  it('refuses a control character (C0, DEL or C1) in any text or key, saying where, and never echoing it', () => {
    const d = doc();
    d.developers[0].title = 'Developer 1\x1b]0;owned\x07';              // an escape sequence, in a pane title
    d.steps[1].see = 'look\there';                                    // a tab: C0 has no exceptions
    d.steps[1].asks[0].say = 'publish\x7f';                           // DEL, typed into a pane
    d.steps[1].asks[0].calls[0].folder = 'release-note-draft-v1\n';   // a line break, in a folder name
    d.steps[1].expect.ana[0] = 'Published\x9b2J';                     // C1 (CSI)
    d.steps[0].asks[0].calls[0].why = 'soon\x00';
    d.steps[1].expect['bo\x1bb'] = ['x'];                              // a key
    const lines = refused(d).split('\n');
    const why = 'scene text must be plain text: it is shown in the panes and typed into them';
    expect(lines).toEqual([
      `developers #1, title: a control character (U+001B); ${why}`,
      `steps #1, asks #1, calls #1, why: a control character (U+0000); ${why}`,
      `steps #2, see: a control character (U+0009); ${why}`,
      `steps #2, asks #1, say: a control character (U+007F); ${why}`,
      `steps #2, asks #1, calls #1, folder: a control character (U+000A); ${why}`,
      `steps #2, expect, ana #1: a control character (U+009B); ${why}`,
      `steps #2, expect: a key with a control character (U+001B); ${why}`,
    ]);
    // the reasons never carry the characters themselves (they'd reach the person's terminal)
    expect(refused(d)).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    // and a scene file read from disk the same way, named
    const f = join(scratch(), 'scenes.yaml');
    const clean = doc();
    clean.developers[1].title = 'Developer 2\x1b[2J';
    writeFileSync(f, stringify(clean));
    expect(() => loadScenes(f, SKILLS_DIR)).toThrow(`${f}: developers #2, title: a control character (U+001B); ${why}`);
  });

  it('the developers\' pane titles say their assistants are scripted (a label in the pane scrolls away)', () => {
    expect(loadScenes(SCENES_FILE).developers.map((d) => d.title)).toEqual(['Developer 1 · ana (scripted)', 'Developer 2 · bob (scripted)']);
  });

  it('loads another file by path (a test scene file), and names the file when it is refused', () => {
    const dir = scratch();
    const f = join(dir, 'scenes.yaml');
    const d = doc();
    d.steps = d.steps.slice(0, 2);
    writeFileSync(f, stringify(d));
    expect(loadScenes(f, SKILLS_DIR).steps).toHaveLength(2);
    expect(() => loadScenes(f)).toThrow(/no skill folder release-note-draft-v1 .* in .*qa-test-.*\/skills/);   // by default, skills/ next to the file
    d.steps[0].see = '';
    writeFileSync(f, stringify(d));
    expect(() => loadScenes(f, SKILLS_DIR)).toThrow(new RegExp(`${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: step 1: no see`));
  });
});

describe('the stand-in assistant', () => {
  it('driven through every step in order, prints every expect string of the developer panes and the log', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const { panes, turns, log } = await playAll(scenes, sandbox(scenes));
    for (const step of scenes.steps) {
      for (const [pane, strings] of Object.entries(step.expect)) {
        if (pane === 'steps') continue;   // the steps view, not the stand-in, draws that pane
        // a developer pane's strings are the product's words (behind the gutter), never the stand-in's own lines
        const text = pane === 'log' ? log : productWords(panes[pane]!);
        for (const s of strings) expect(text, `step ${step.id}, ${pane}: ${s}`).toContain(s);
      }
    }
    expect(turns.every((t) => t.ok)).toBe(true);
  });

  it('a publish says what the surface says (publish.published), and what the catalog flagged in its review words, orange', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const { panes } = await playAll(scenes, sandbox(scenes));
    const published = (name: string, version: number) => surface.format(surface.word('publish.published'), { name, version });
    const words = productWords(panes.ana!);
    for (const [name, version] of [['release-note-draft', 1], ['sql-migrations', 1], ['release-note-draft', 2]] as const) expect(words).toContain(published(name, version));
    const review = surface.format(surface.word('publish.review'), { notes: surface.format(surface.word('quality.note.runnable_file'), { path: 'scripts/collect.sh' }) }).trim();
    expect(review).toBe('Review: includes something that can run (scripts/collect.sh).');
    expect(panes.ana!.split('\n').filter((l) => l.includes('\x1b[38;5;208m')).map(plain)).toEqual([`  │ ${review}`]);
    expect(plain(panes.ana!)).not.toMatch(/published \S+ v\d as ana|risk flags/);   // the stand-in's own line is gone
  });

  it('prints each call with its tool name from the surface, and the result indented', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const { panes } = await playAll(scenes, sandbox(scenes));
    const ana = plain(panes.ana!), bob = plain(panes.bob!);
    expect(ana).toContain(`● ${surface.names.publish}  release-note-draft\n  │ Published release-note-draft v1 to the shared catalog (fingerprint checked).`);
    expect(bob).toContain(`● ${surface.names.search}  "changelog for a release"\n  │ Shared catalog: 1 of 2 skills match`);
    expect(bob).toContain(`● ${surface.names.versions}  release-note-draft\n`);
    expect(bob).toContain(`● ${surface.names.diff}  release-note-draft v1 → v2\n`);
    // planned parts: dimmed, with why, and nothing done
    expect(panes.ana).toContain(`\x1b[2m  ● ${surface.cli} setup: not in this demo: it wires each assistant to the catalog itself\x1b[0m`);
    expect(panes.bob).toContain(`\x1b[2m  ● ${surface.names.install}: shown with the catalog's server (run without --core)\x1b[0m`);
    expect(panes.bob).toContain(`\x1b[2m  ● ${surface.names.update}: shown with the catalog's server (run without --core): risky updates are held until you say yes\x1b[0m`);
  });

  it('colours alerts orange and tool calls green: the not_owner line and "Can run something new on this machine: yes"', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const { panes } = await playAll(scenes, sandbox(scenes));
    const orange = panes.bob!.split('\n').filter((l) => l.includes('\x1b[38;5;208m')).map(plain);
    expect(orange.some((l) => l.includes('Can run something new on this machine: yes'))).toBe(true);
    expect(orange.some((l) => l.includes('- added: "scripts/collect.sh" (can run)'))).toBe(true);
    expect(orange.some((l) => l.includes('not_owner: release-note-draft belongs to ana'))).toBe(true);
    expect(orange.some((l) => l.includes('Shared catalog'))).toBe(false);
    expect(panes.bob).toContain(`\x1b[32m● ${surface.names.search}`);
  });

  it('writes one turns.jsonl line per ask, with the step, ok and no colour', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const { turnsFile } = await playAll(scenes, sandbox(scenes));
    const lines = turnsFile.trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((t) => [t.who, t.step, t.ok])).toEqual(scenes.steps.flatMap((s) => s.asks.map((a) => [a.who, s.id, true])));
    expect(lines.every((t) => Object.keys(t).join() === 'who,say,step,ok,at' && !Number.isNaN(Date.parse(t.at)))).toBe(true);
    expect(turnsFile).not.toMatch(/\x1b/);
  });

  // The result column is as wide as the surface's longest log word, "refused: the catalog's copy doesn't match its
  // fingerprint" (57), as the catalog's server pads it.
  const R = 57;
  const row = (who: string, tool: string, result: string, target: string) => `01:52:03  ${who.padEnd(4)}  ${tool.padEnd(27)}  ${result.padEnd(R)}  ${target}`;

  it('activity.log: one line per tool call, in columns (UTC time, who, tool 27, result 57, then the target), no colour, in the surface\'s log words', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const at = new Date('2026-09-29T01:52:03Z');   // 21:52 in New York: the log says UTC
    const { log } = await playAll(scenes, sandbox(scenes), () => at);
    const lines = log.trimEnd().split('\n');
    expect(RESULT_WIDTH).toBe(R);
    // a planned part is no tool call (nothing happened), so it has no line; nor has the command line's, planned on the core
    expect(lines).toHaveLength(scenes.steps.flatMap((s) => s.asks.flatMap((a) => a.calls.filter((c) => !('planned' in c) && !CLI_OPS.includes(c.op)))).length);
    expect(log).not.toMatch(/\x1b|planned|setup/);
    for (const l of lines) expect(l, l).toMatch(new RegExp(`^01:52:03  (ana |bob )  [a-z_ -]{27}  [a-z0-9,:_' -]{${R}}  \\S`));
    // results are the surface's words; the target is skill names and versions only (a search: its match count; a
    // refusal: "-"), as the server logs them
    expect(lines).toEqual([
      row('ana', 'publish_skill_to_catalog', 'published', 'release-note-draft v1'),
      row('ana', 'publish_skill_to_catalog', 'published', 'sql-migrations v1'),
      row('bob', 'search_shared_skills', 'found', '1 of 2 match'),
      row('ana', 'publish_skill_to_catalog', 'published', 'release-note-draft v2'),
      row('bob', 'list_shared_skill_versions', 'listed', 'release-note-draft v2'),
      row('bob', 'diff_shared_skill_versions', 'adds something that can run', 'release-note-draft v1 → v2'),
      row('bob', 'publish_skill_to_catalog', 'refused: not the owner', '-'),
      row('bob', 'search_shared_skills', 'closest only', '1 of 2 match'),
    ]);
    // a long skill name, last on its line, never shifts a column
    expect(logLine({ at, who: 'ana', tool: 'read_shared_skill', target: `${'a'.repeat(64)} v1`, result: 'read' }, ['ana'])).toBe(row('ana', 'read_shared_skill', 'read', `${'a'.repeat(64)} v1`));
  });

  it('the log\'s words are the surface\'s own, the same as the catalog\'s server reads them; every result fits its column', async () => {
    const at = new Date('2026-09-29T01:52:03Z');
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const logged = async (catalog: Partial<Catalog>, c: Parameters<Backend['call']>[1]) => {
      const reply = await coreBackend({ catalog: catalog as Catalog, surface, skillsDir: join(root, 'work', 'ana', 'skills') }).call('ana', c);
      return logLine({ at, who: 'ana', tool: 'publish_skill_to_catalog', ...reply.log! }, ['ana', 'bob']);
    };
    const publish = { op: 'publish' as const, name: 'release-note-draft', folder: 'release-note-draft-v1' };
    const flag = (kind: string, path: string) => ({ kind, path, detail: path });
    const codes = Object.keys(surface.doc.log.error);
    expect(codes).toContain('not_owner');
    const lines = [
      await logged({ publish: async () => ({ name: 'release-note-draft', version: 12, created: true, risk_flags: [flag('runnable_file', 'a.sh'), flag('non_markdown', 'b.bin')] }) as any }, publish),
      ...(await Promise.all(codes.map((code) => logged({ publish: async () => { throw new CatalogError(code as never, {}); } }, publish)))),
    ];
    expect(lines[0]).toBe(row('ana', 'publish_skill_to_catalog', 'published', 'release-note-draft v12'));
    for (const l of lines) expect(l.length - l.trimEnd().length, l).toBe(0);
    for (const l of lines) expect(l.slice(0, 8 + 2 + 4 + 2 + 27 + 2 + R + 2), l).toMatch(/  $/);   // the target starts at the same column
    // the catalog's server reads the same words (its activity module, loaded as it is: its only import from the core is a type)
    const client = fileURLToPath(new URL('../../client/src/activity.ts', import.meta.url));
    const theirs = (await import(client)).logWords(surface), ours = logWords(surface);
    expect(ours.width).toBe(theirs.width);
    for (const [op, w] of Object.entries(surface.doc.log.result as Record<string, string | Record<string, string>>)) {
      for (const outcome of typeof w === 'string' ? [undefined] : Object.keys(w)) expect(ours.result(op, outcome), `${op} ${outcome}`).toBe(theirs.result(op, outcome));
    }
    for (const code of [...codes, 'made_up']) expect(ours.error(code), code).toBe(theirs.error(code));
    expect(ours.searchTarget(1, 2)).toBe(theirs.searchTarget(1, 2));
  });

  it('the who column is as wide as the longest developer id (at least 4)', () => {
    const at = new Date('2026-09-29T01:52:03Z');
    const line = (who: string, developers: string[]) => logLine({ at, who, tool: 't', target: 'x', result: 'r' }, developers);
    expect(line('ana', ['ana', 'bob'])).toMatch(/^01:52:03  ana   t /);
    expect(line('ana', ['ana', 'carol-dev'])).toMatch(/^01:52:03  ana {8}t /);
    expect(line('carol-dev', ['ana', 'carol-dev'])).toMatch(/^01:52:03  carol-dev  t /);
    expect(line('mallory', ['ana', 'carol-dev'])).toMatch(/^01:52:03  - {10}t /);
  });

  it('activity.log never holds what anyone typed: no query words, no skill text, no messages or paths', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { log } = await playAll(scenes, root);
    const calls = scenes.steps.flatMap((s) => s.asks.flatMap((a) => a.calls));
    const names = calls.flatMap((c) => ('name' in c ? [c.name] : []));
    const typed = [
      // a query word that is also in a skill's name ("release") may show, as the name
      ...calls.flatMap((c) => ('query' in c ? [c.query, ...c.query.split(' ')] : [])).filter((w) => w.length > 3 && !names.some((n) => n.includes(w))),
      ...calls.flatMap((c) => ('message' in c && c.message ? [c.message] : [])),
      ...scenes.steps.flatMap((s) => s.asks.map((a) => a.say)),
      'Write release notes', 'Write safe SQL', 'scripts/collect.sh', 'template.md', root,
    ];
    for (const t of typed) expect(log.toLowerCase(), t).not.toContain(t.toLowerCase());
  });

  it('activity.log never holds a free-text field: a marker in every one (asks, see, titles, why, queries, messages, folder names, every file of a skill, a missing name) never reaches it', async () => {
    const M = 'qzmarkerqz';
    const d = doc();
    const skills = scratch('qa-demo-skills-');
    const marked = (f: string) => `${f}-${M}`;
    for (const dev of d.developers) {
      dev.title += ` ${M}`;
      for (const f of dev.skills) cpSync(join(SKILLS_DIR, f), join(skills, marked(f)), { recursive: true });
      dev.skills = dev.skills.map(marked);
    }
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
    const v2 = files(join(skills, marked('release-note-draft-v2')));
    expect(v2.length).toBe(3);
    for (const f of v2) appendFileSync(f, `\n${M}\n`);
    for (const step of d.steps) {
      step.title += ` ${M}`;
      step.see += ` ${M}`;
      for (const ask of step.asks) {
        ask.say += ` ${M}`;
        for (const c of ask.calls) {
          if (c.folder) c.folder = marked(c.folder);
          for (const k of ['why', 'query', 'message']) if (typeof c[k] === 'string') c[k] += ` ${M}`;
        }
      }
      for (const pane of Object.keys(step.expect ?? {})) step.expect[pane] = step.expect[pane].map((x: string) => `${x} ${M}`);
    }
    d.steps.push({ id: 9, title: `read ${M}`, see: M, asks: [{ who: 'bob', say: `read ${M}`, calls: [{ op: 'read', name: `${M}-missing` }] }], expect: { bob: [M] } });
    const scenes = parseScenes(d, skills);
    const { log, panes } = await playAll(scenes, sandbox(scenes, skills));
    expect(plain(panes.bob!)).toContain(`not_found: no skill named "${M}-missing"`);   // the pane shows what was asked, the log doesn't
    expect(log.trimEnd().split('\n')).toHaveLength(scenes.steps.flatMap((x) => x.asks.flatMap((a) => a.calls.filter((c) => !('planned' in c) && !CLI_OPS.includes(c.op)))).length);
    expect(log).not.toContain(M);
  });

  it('a read logs the skill and version; a name the catalog doesn\'t have logs "-" as the target', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st, panes } = await stages(scenes, root);
    await answer(st.ana!, 'publish my skills, release-note-draft and sql-migrations');
    const extra = { ...scenes, steps: [...scenes.steps, { id: 9, title: 't', see: 's', asks: [
      { who: 'bob', say: 'read it', calls: [{ op: 'read' as const, name: 'release-note-draft' }] },
      { who: 'bob', say: 'read relase-note-draft', calls: [{ op: 'read' as const, name: 'relase-note-draft' }] },
    ], expect: {} }] };
    const bob = { ...st.bob!, scenes: extra };
    expect((await answer(bob, 'read it')).ok).toBe(true);
    expect((await answer(bob, 'read relase-note-draft')).ok).toBe(true);   // a not_found is the catalog's answer, not a failure
    // stable phrases only: the fence around SKILL.md and the date format are the core's to change
    expect(plain(panes.bob!)).toContain(`● ${surface.names.get}  release-note-draft\n  │ release-note-draft v1 (latest), published by ana`);
    expect(plain(panes.bob!)).toContain('  │ name: release-note-draft\n');
    expect(plain(panes.bob!)).toContain('  │ List the merged pull requests since the last tag, group them by area, and fill template.md.\n');
    expect(plain(panes.bob!)).toContain('not_found: no skill named "relase-note-draft" in the shared catalog. Names spelled like it: release-note-draft.');
    const log = readFileSync(join(root, 'demo', 'activity.log'), 'utf8').trimEnd().split('\n').slice(-2);
    expect(log.map((l) => l.slice(8))).toEqual([row('bob', 'read_shared_skill', 'read', 'release-note-draft v1'), row('bob', 'read_shared_skill', 'not found', '-')].map((l) => l.slice(8)));
  });

  it('makes no folder: without the demo folder (the director makes it) an ask fails, and none appears', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st } = await stages(scenes, root);
    const elsewhere = join(scratch('qa-demo-'), 'demo');
    const ask = 'publish my skills, release-note-draft and sql-migrations';
    await expect(answer({ ...st.ana!, demoDir: elsewhere }, ask)).rejects.toThrow(/ENOENT/);
    expect(await answer({ ...st.ana!, logFile: join(elsewhere, 'activity.log') }, ask)).toMatchObject({ ok: false });
    expect(existsSync(elsewhere)).toBe(false);
  });

  it('an ask it doesn\'t know: says so, logs nothing, turn with step null', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st, panes } = await stages(scenes, root);
    const t = await answer(st.ana!, 'write me a poem');
    expect(t).toMatchObject({ who: 'ana', say: 'write me a poem', step: null, ok: true });
    expect(plain(panes.ana!)).toContain("(this stand-in only knows the demo's steps)");
    expect(existsSync(join(root, 'demo', 'activity.log'))).toBe(false);
    // bob's asks aren't ana's
    expect((await answer(st.ana!, 'what changed in release-note-draft v2?')).step).toBeNull();
  });

  it('an unexpected error (a folder that isn\'t there) is ok: false, and the next asks still run', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st, panes, catalogs } = await stages(scenes, root);
    const broken = { ...st.ana!, backend: coreBackend({ catalog: catalogs.ana!, surface, skillsDir: join(root, 'nowhere') }) };
    const t = await answer(broken, 'publish my skills, release-note-draft and sql-migrations');
    expect(t).toMatchObject({ step: 2, ok: false });
    // the stand-in's own error: orange, from the line's start, never behind the gutter the catalog's words have
    const said = panes.ana!.split('\n').find((l) => plain(l).startsWith('✗ stand-in error: '));
    expect(said).toMatch(/^\x1b\[38;5;208m✗ stand-in error: .+\x1b\[0m$/);
    expect(productWords(panes.ana!)).not.toContain('error');
    // it isn't the catalog's answer: no log line (the server logs only its own calls, too)
    expect(existsSync(join(root, 'demo', 'activity.log'))).toBe(false);
    expect((await answer(st.ana!, 'publish my skills, release-note-draft and sql-migrations')).ok).toBe(true);
  });

  it('a catalog that fails to open is each call\'s error; planned calls still answer', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st, panes } = await stages(scenes, root);
    const failing = Promise.reject(new Error('database is locked'));
    failing.catch(() => undefined);
    const ana = { ...st.ana!, backend: coreBackend({ catalog: failing, surface, skillsDir: join(root, 'work', 'ana', 'skills') }) };
    expect((await answer(ana, 'install the skill manager')).ok).toBe(true);
    expect((await answer(ana, 'publish my skills, release-note-draft and sql-migrations')).ok).toBe(false);
    expect(plain(panes.ana!)).toContain('\n✗ stand-in error: database is locked\n');
    expect(plain(panes.ana!)).not.toContain('│ error');
  });

  it('the stand-in\'s own error of several lines: every line orange, the first after ✗, the rest indented, none behind the gutter or with its control characters', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st, panes } = await stages(scenes, root);
    const failing: Backend = { call: async () => { throw new Error('first\x1b[2J line\nsecond line'); } };
    expect((await answer({ ...st.bob!, backend: failing }, 'find me a skill for release changelogs')).ok).toBe(false);
    expect(panes.bob).toContain('\x1b[38;5;208m✗ stand-in error: first [2J line\x1b[0m\n\x1b[38;5;208m  second line\x1b[0m\n');
    expect(productWords(panes.bob!)).toBe('');
  });

  it('the catalog is behind a Backend: another one (later, the MCP server) changes nothing else, and may log for itself', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const { stages: st, panes } = await stages(scenes, root);
    const seen: [string, unknown][] = [];
    const server: Backend = { call: async (who, c) => { seen.push([who, c]); return { text: 'Shared catalog: 1 of 2 skills match\nsecond line', alert: [1] }; } };
    const t = await answer({ ...st.bob!, backend: server }, 'find me a skill for release changelogs');
    expect(t).toMatchObject({ step: 3, ok: true });
    expect(seen).toEqual([['bob', { op: 'search', query: 'changelog for a release' }]]);
    expect(panes.bob).toContain(`\x1b[32m● ${surface.names.search}  "changelog for a release"\x1b[0m\n`);
    expect(panes.bob).toContain('\x1b[38;5;208m  │ second line\x1b[0m');
    expect(existsSync(join(root, 'demo', 'activity.log'))).toBe(false);   // no log words: the server wrote its own line
  });

  it('logLine: who is "-" unless a known developer; columns padded, never cut; no control characters', () => {
    const at = new Date('2026-09-29T23:59:58.900Z');
    expect(logLine({ at, who: 'ana', tool: 'search_shared_skills', target: '1 of 2 match', result: 'matched every word' }, ['ana', 'bob']))
      .toBe('23:59:58  ana   search_shared_skills         matched every word' + ' '.repeat(R - 18) + '  1 of 2 match');
    expect(logLine({ at, who: 'ana', tool: 't', target: 'a\x1b[31mb\nc', result: 'r' }, ['ana'])).not.toMatch(/[\x00-\x1f]/);
    expect(logLine({ at, who: 'mallory', tool: 't', target: 'x', result: 'r' }, ['ana', 'bob'])).toMatch(/^23:59:58  -     t /);
    expect(logLine({ at, who: '', tool: 't', target: 'x', result: 'r' }, ['ana', 'bob'])).toMatch(/^23:59:58  -     t /);
  });
});

describe('the stand-in as a process (the REPL around the step function)', () => {
  it('answers a line from stdin with the prompt, then exits at the end of input', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    mkdirSync(join(root, 'catalog'));
    const child = spawn(process.execPath, [here('../src/demo/assistant.ts'), '--as', 'ana'], {
      cwd: join(root, 'work', 'ana'), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, SKILLS_CATALOG: pathToFileURL(join(root, 'catalog')).href, QA_SANDBOX: root, DEMO_PACE: '0', DEMO_SCENES: SCENES_FILE, SKILLS_ACTIVITY_LOG: join(root, 'elsewhere.log') },
    });
    let out = '', err = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { err += b; });
    child.stdin.end('publish my skills, release-note-draft and sql-migrations\n');
    const code = await new Promise((ok) => child.on('exit', ok));
    expect(code, err).toBe(0);
    expect(err).toBe('');   // no SQLite warning in the pane
    expect(plain(out)).toContain('› ');
    expect(plain(out)).toContain('  │ Published release-note-draft v1 to the shared catalog');
    expect(readFileSync(join(root, 'elsewhere.log'), 'utf8')).toMatch(/published +release-note-draft v1/);   // SKILLS_ACTIVITY_LOG wins
    expect(readFileSync(join(root, 'demo', 'turns.jsonl'), 'utf8')).toMatch(/"step":2/);
  });

  it('both panes start at once: neither opens the catalog until it is asked something (two processes opening a new catalog together can fail)', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    mkdirSync(join(root, 'catalog'));
    const env = { ...process.env, SKILLS_CATALOG: pathToFileURL(join(root, 'catalog')).href, QA_SANDBOX: root, DEMO_PACE: '0', DEMO_SCENES: SCENES_FILE };
    const panes = ['ana', 'bob'].map((who) => {
      const child = spawn(process.execPath, [here('../src/demo/assistant.ts'), '--as', who], { stdio: ['pipe', 'pipe', 'pipe'], env });
      const p = { child, out: '', exit: new Promise((ok) => child.on('exit', ok)) };
      child.stdout.on('data', (b) => { p.out += b; });
      return p;
    });
    const turns = () => (existsSync(join(root, 'demo', 'turns.jsonl')) ? readFileSync(join(root, 'demo', 'turns.jsonl'), 'utf8') : '');
    const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); };
    try {
      await until(() => panes.every((p) => p.out.includes('› ')));
      expect(panes.every((p) => p.child.exitCode === null)).toBe(true);
      expect(existsSync(join(root, 'catalog', 'catalog.sqlite'))).toBe(false);
      panes[0]!.child.stdin.write('install the skill manager\n');
      await until(() => turns().includes('"ana"'));
      expect(existsSync(join(root, 'catalog', 'catalog.sqlite'))).toBe(true);
      panes[1]!.child.stdin.write('install the skill manager\n');
      await until(() => turns().includes('"bob"'));
      for (const p of panes) p.child.stdin.end();
      expect(await Promise.all(panes.map((p) => p.exit))).toEqual([0, 0]);
    } finally {
      for (const p of panes) p.child.kill();
      await Promise.all(panes.map((p) => p.exit));
    }
  });

  it('refuses to start without its settings or for someone who isn\'t a developer (exit 3, one line)', async () => {
    const scenes = loadScenes(SCENES_FILE);
    const root = sandbox(scenes);
    const run = (args: string[], env: Record<string, string>) => new Promise<{ code: number | null; err: string }>((ok) => {
      const c = spawn(process.execPath, [here('../src/demo/assistant.ts'), ...args], { stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH ?? '', ...env } });
      let err = '';
      c.stderr.on('data', (b) => { err += b; });
      c.on('exit', (code) => ok({ code, err }));
    });
    const env = { SKILLS_CATALOG: pathToFileURL(join(root, 'catalog')).href, QA_SANDBOX: root };
    expect(await run(['--as', 'carol'], env)).toMatchObject({ code: 3, err: expect.stringMatching(/carol is not a developer in .*scenes\.yaml/) });
    expect(await run(['--as', 'ana'], { QA_SANDBOX: root })).toMatchObject({ code: 3, err: expect.stringMatching(/SKILLS_CATALOG/) });
    expect(await run([], env)).toMatchObject({ code: 3, err: expect.stringMatching(/--as/) });
  });
});

describe('the steps view', () => {
  const state: StepsState = {
    title: 'What to look for', mode: 'auto', paused: false, message: '',
    steps: [
      { id: 1, title: 'both install the skill manager', see: 'planned: the installer turns the tools on', state: 'planned' },
      { id: 2, title: 'ana publishes', see: '"published release-note-draft v1 as ana"', state: 'seen' },
      { id: 5, title: 'bob compares v1 and v2', see: '"Can run something new: yes", in orange', state: 'now' },
      { id: 6, title: 'bob publishes over ana\'s skill', see: 'not_owner', state: 'missed', missing: ['not_owner: release-note-draft belongs to ana'] },
      { id: 7, title: 'bob searches', see: 'nothing matches exactly', state: 'pending' },
    ],
  };

  it('draws each state with its mark and colour: ✓ seen green, ▶ now bold green with see, ◌ planned dim, ✗ missed orange, pending plain', () => {
    const out = renderSteps(state, { width: 60 });
    const lines = out.split('\n');
    const line = (s: string) => lines.find((l) => plain(l).includes(s))!;
    expect(plain(out)).toContain('What to look for');
    expect(line('both install')).toBe('\x1b[2m◌ 1  both install the skill manager\x1b[0m');
    expect(plain(out)).toContain('     planned: the installer turns the tools on');
    expect(line('ana publishes')).toBe('\x1b[32m✓\x1b[0m 2  ana publishes');
    expect(line('bob compares')).toBe('\x1b[1;32m▶ 5  bob compares v1 and v2\x1b[0m');
    expect(plain(out)).toContain('     see: "Can run something new: yes", in orange');
    expect(line('over ana')).toBe('\x1b[38;5;208m✗ 6  bob publishes over ana\'s skill\x1b[0m');
    expect(plain(out)).toContain('     missing: not_owner: release-note-draft belongs to ana');
    expect(line('bob searches')).toBe('  7  bob searches');
    expect(plain(out)).toContain('     see: nothing matches exactly');
    expect(plain(lines.at(-1)!)).toBe('Enter next · p pause · q quit');
    // a seen step's see line is gone (done), the now step keeps it
    expect(plain(out)).not.toContain('see: "published release-note-draft v1 as ana"');
  });

  it('shows the message, paused and step mode; wraps long lines under their step', () => {
    const out = plain(renderSteps({ ...state, paused: true, mode: 'step', message: 'Done: 5 seen, 2 planned, 1 missed.' }, { width: 34 }));
    expect(out).toContain('Done: 5 seen, 2 planned, 1 missed.');
    expect(out).toMatch(/paused/);
    expect(out).toMatch(/Enter next · p pause · q quit/);
    for (const l of out.split('\n')) expect(l.length, l).toBeLessThanOrEqual(34);
    expect(out).toContain('▶ 5  bob compares v1 and v2\n     see: "Can run something new:\n     yes", in orange');
    expect(out).toContain("✗ 6  bob publishes over ana's\n     skill");
  });

  it('before the conductor writes steps.json, says it is waiting', () => {
    expect(plain(renderSteps(null, { width: 40 }))).toMatch(/waiting for the demo to start/);
  });

  it('maps keys: Enter → next, p → pause, q or Ctrl-C → quit, anything else → nothing', () => {
    expect(['\r', '\n', 'p', 'P', 'q', 'Q', '\x03', 'x', ' ', '\x1b[A'].map(keyCommand)).toEqual(['next', 'next', 'pause', 'pause', 'quit', 'quit', 'quit', null, null, null]);
  });

  it('as a process: redraws from steps.json and appends each key\'s word to control', async () => {
    const root = scratch('qa-demo-');
    mkdirSync(join(root, 'demo'));
    writeFileSync(join(root, 'demo', 'steps.json'), JSON.stringify(state));
    const child = spawn(process.execPath, [here('../src/demo/steps-view.ts')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QA_SANDBOX: root } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    const until = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); };
    await until(() => out.includes('bob compares'));
    writeFileSync(join(root, 'demo', 'steps.json'), JSON.stringify({ ...state, message: 'second draw' }));
    await until(() => out.includes('second draw'));
    child.stdin.write('\r');
    child.stdin.write('p');
    child.stdin.end('q');
    const code = await new Promise((ok) => child.on('exit', ok));
    expect(code).toBe(0);
    expect(plain(out)).toContain('second draw');
    expect(readFileSync(join(root, 'demo', 'control'), 'utf8')).toBe('next\npause\nquit\n');
  });

  it('as a process, makes no folder: without the demo folder (the director makes it), none appears', async () => {
    const root = scratch('qa-demo-');
    const child = spawn(process.execPath, [here('../src/demo/steps-view.ts')], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, QA_SANDBOX: root } });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    for (let i = 0; i < 100 && !out.includes('waiting for the demo'); i++) await new Promise((r) => setTimeout(r, 50));
    child.stdin.end();
    await new Promise((ok) => child.on('exit', ok));
    expect(plain(out)).toContain('waiting for the demo to start');
    expect(existsSync(join(root, 'demo'))).toBe(false);
  });
});

describe('the scenes and the product\'s words', () => {
  it('every tool the stand-in names is a tool in the surface (or the setup command)', () => {
    const tools = new Set([...Object.values(surface.names), `${surface.cli} setup`]);
    const scenes = loadScenes(SCENES_FILE);
    const ops = scenes.steps.flatMap((s) => s.asks.flatMap((a) => a.calls.map((c) => ('planned' in c ? c.planned : c.op))));
    for (const op of ops) expect(tools.has(op === 'setup' ? `${surface.cli} setup` : surface.names[op === 'read' ? 'get' : op]!), op).toBe(true);
  });
});

describe('the stand-in wraps the product\'s words at the pane\'s width', () => {
  it('cuts at spaces, keeps whole words, and cuts a word longer than the width where it must', () => {
    const line = 'Can run something new on this machine: yes, because it adds or changes scripts/collect.sh';
    const lines = wrap(line, 30);
    expect(lines.every((l) => l.length <= 30)).toBe(true);
    expect(lines.join(' ')).toBe(line);
    expect(wrap('short', 30)).toEqual(['short']);
    expect(wrap('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
    expect(wrap(line, 0)).toEqual([line]);
  });
});
