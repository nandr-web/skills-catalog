// Publishing a folder over MCP (contract §3, publish_skill_to_catalog): two steps, so the person sees what would be
// published before it is. A preview stores nothing and gives a confirm value; the confirm publishes exactly the folder's
// files, never the ignore list, never through a link; a changed folder, a newer version, another owner or a suspected
// secret each refuse, storing nothing; an assistant can't override a secret. These run through the real server over
// stdio and check what the catalog stored, read back through the core.
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { actAs, CatalogError, renderError, Surface, type Catalog } from '@skills-catalog/core';
import { afterEach, describe, expect, it } from 'vitest';
import { open, request, seed, skillMd } from './seed.ts';
import { place, startServer, type Place, type Server } from './server.ts';

const S = Surface.load();
const P = S.names['publish']!;
const LOG = S.fill(S.doc.log) as { result: Record<string, any>; error: Record<string, string> };
const IGNORED = ['.git/config', '.env', '.env.local', 'id_rsa', 'deploy-key.pem', '.DS_Store'];

const servers: Server[] = [];
const catalogs: Catalog[] = [];
function start(p: Place, env: Record<string, string> = {}): Server {
  const s = startServer(p, env);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const c of catalogs.splice(0)) c.close();
  for (const s of servers.splice(0)) await s.close();
});

/** A skill folder in the sandbox: SKILL.md, a script, and every name on the ignore list. */
function folder(p: Place, name: string, body = 'Body.\n', extra: Record<string, string> = {}): string {
  const dir = join(p.dir, 'work', name);
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMd(name, `The ${name} skill.`, body));
  writeFileSync(join(dir, 'scripts', 'run.sh'), '#!/bin/sh\necho run\n', { mode: 0o755 });
  for (const f of IGNORED) writeFileSync(join(dir, f), `ignored: ${f}\n`);
  for (const [f, text] of Object.entries(extra)) writeFileSync(join(dir, f), text);
  return dir;
}

/** Step 2's values in a preview: the surface's words end with `confirm "<value>", name "<name>", version <n>, files <n>
 *  and flags [<kinds>]`. */
function step2In(text: string) {
  expect(S.word('publish').preview).toContain('confirm "{confirm}", name "{name}", version {version}, files {n_send} and flags {flags}');
  const m = /confirm "([^"]*)", name "([^"]*)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(text);
  if (!m) throw new Error(`no step-2 values in: ${text.slice(0, 300)}`);
  return { confirm: m[1]!, name: m[2]!, version: Number(m[3]), files: Number(m[4]), flags: JSON.parse(m[5]!) as string[] };
}

async function versionsOf(c: Catalog, name: string): Promise<number[]> {
  try {
    return (await c.versions({ name })).versions.map((v) => v.version).sort((a, b) => a - b);   // the core lists newest first
  } catch (e) {
    if (e instanceof CatalogError && e.code === 'not_found') return [];
    throw e;
  }
}

/** The files a version holds, read back through the core, as {path: text}. */
async function stored(c: Catalog, name: string, version: number): Promise<Record<string, string>> {
  const f = await c.fetch({ name, version });
  return Object.fromEntries(f.files.map((x) => [x.path, Buffer.from(x.content_base64, 'base64').toString('utf8')]));
}

async function setup(env: Record<string, string> = { SKILLS_AS: 'dev2' }) {
  const p = place();
  await seed(p);
  const c = await open(p);
  catalogs.push(c);
  const s = start(p, env);
  await s.initialize();
  return { p, c, s };
}

describe('publish_skill_to_catalog over MCP', () => {
  it('is served with folder, message, confirm and step 2\'s values; the person-only override (allow_suspected_secrets) is never in its schema', async () => {
    const { s } = await setup();
    const tool = ((await s.send('tools/list')).result.tools as { name: string; inputSchema: { properties: Record<string, unknown> } }[]).find((t) => t.name === P);
    expect(tool, 'the publish tool is listed').toBeDefined();
    expect(Object.keys(tool!.inputSchema.properties).sort()).toEqual(['confirm', 'files', 'flags', 'folder', 'message', 'name', 'version']);
  });

  it('a preview stores nothing and gives a confirm; the confirm publishes exactly the folder\'s files, as the acting developer; the log says so', async () => {
    const { p, c, s } = await setup();
    const dir = folder(p, 'weekly-report-writer');
    const preview = await s.call(P, { folder: dir, message: 'First version.' });
    expect(preview.isError, preview.content[0]!.text).toBeUndefined();
    expect(preview.content[0]!.text).toContain(JSON.stringify(dir));
    expect(await versionsOf(c, 'weekly-report-writer')).toEqual([]);   // nothing stored by a preview

    const done = await s.call(P, { folder: dir, ...step2In(preview.content[0]!.text), message: 'First version.' });
    expect(done.isError, done.content[0]!.text).toBeUndefined();
    expect(await versionsOf(c, 'weekly-report-writer')).toEqual([1]);
    expect(await stored(c, 'weekly-report-writer', 1)).toEqual({
      'SKILL.md': readFileSync(join(dir, 'SKILL.md'), 'utf8'),
      'scripts/run.sh': readFileSync(join(dir, 'scripts', 'run.sh'), 'utf8'),
    });
    const v = (await c.versions({ name: 'weekly-report-writer' })).versions[0]!;
    expect([v.publisher, v.message]).toEqual(['dev2', 'First version.']);
    const log = readFileSync(join(p.home, 'activity.log'), 'utf8').trim().split('\n').slice(-2);
    expect(log[0]).toContain(LOG.result.publish.preview);
    expect(log[1]).toContain(LOG.result.publish.published);
  });

  it('never sends the ignore list, and never reads through a link out of the folder: the sentinel\'s bytes are never sent', async () => {
    const { p, c, s } = await setup();
    const dir = folder(p, 'link-holder');
    const sentinel = `QA-SENTINEL-${Date.now()}`;
    mkdirSync(join(p.dir, 'outside'), { recursive: true });
    writeFileSync(join(p.dir, 'outside', 'secret.txt'), sentinel + '\n');
    symlinkSync(join(p.dir, 'outside', 'secret.txt'), join(dir, 'looks-harmless.md'));
    const preview = await s.call(P, { folder: dir });
    expect(preview.content[0]!.text).not.toContain(sentinel);
    if (!preview.isError) {
      await s.call(P, { folder: dir, ...step2In(preview.content[0]!.text) });
      for (const v of await versionsOf(c, 'link-holder')) {
        const files = await stored(c, 'link-holder', v);
        for (const f of IGNORED) expect(Object.keys(files), f).not.toContain(f);
        for (const text of Object.values(files)) expect(text).not.toContain(sentinel);
      }
    }
  });

  it('a folder changed between the preview and the confirm is refused (preview again); nothing stored', async () => {
    const { p, c, s } = await setup();
    const dir = folder(p, 'changing-skill');
    const step2 = step2In((await s.call(P, { folder: dir })).content[0]!.text);
    writeFileSync(join(dir, 'SKILL.md'), skillMd('changing-skill', 'The changing-skill skill.', 'Edited after the preview.\n'));
    const r = await s.call(P, { folder: dir, ...step2 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text.split('\n')[0]).toBe(S.word('errors').publish_conflict);   // then the acting line
    expect(await versionsOf(c, 'changing-skill')).toEqual([]);
  });

  it('a confirm from another skill\'s preview is refused; nothing stored', async () => {
    const { p, c, s } = await setup();
    const a = folder(p, 'skill-a');
    const b = folder(p, 'skill-b');
    const step2A = step2In((await s.call(P, { folder: a })).content[0]!.text);
    const r = await s.call(P, { folder: b, ...step2A });
    expect(r.isError).toBe(true);
    expect(await versionsOf(c, 'skill-a')).toEqual([]);
    expect(await versionsOf(c, 'skill-b')).toEqual([]);
  });

  it('a newer version landing between the steps is refused with the name\'s conflict; nothing more stored', async () => {
    const { p, c, s } = await setup();
    await c.publish(request('racing-skill', [{ path: 'SKILL.md', text: skillMd('racing-skill', 'The racing-skill skill.') }]), actAs('dev2'));
    const dir = folder(p, 'racing-skill', 'The folder\'s version.\n');
    const step2 = step2In((await s.call(P, { folder: dir })).content[0]!.text);
    await c.publish(request('racing-skill', [{ path: 'SKILL.md', text: skillMd('racing-skill', 'The racing-skill skill.', 'Landed in between.\n') }]), actAs('dev2'));
    const r = await s.call(P, { folder: dir, ...step2 });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^conflict: /);
    expect(await versionsOf(c, 'racing-skill')).toEqual([1, 2]);
  });

  it('another developer\'s skill: not_owner already at the preview; nothing stored', async () => {
    const { p, c, s } = await setup();
    const dir = folder(p, 'release-notes-kit');   // ana's, in the seed
    const r = await s.call(P, { folder: dir });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^not_owner: /);
    expect(r.content[0]!.text).toContain('ana');
    expect(await versionsOf(c, 'release-notes-kit')).toEqual([1, 2]);
  });

  it('a suspected secret stops the preview, naming the file and line but never the value; the assistant can\'t pass the override', async () => {
    const key = 'AKIA' + 'IOSFODNN7' + 'EXAMPLE';
    const { p, c, s } = await setup();
    const dir = folder(p, 'leaky-skill', `Use key ${key} to call it.\n`);
    const r = await s.call(P, { folder: dir });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toMatch(/^secret_suspected: /);
    expect(r.content[0]!.text).toContain('SKILL.md');
    expect(r.content[0]!.text).not.toContain(key);
    const forced = await s.call(P, { folder: dir, allow_suspected_secrets: true });
    expect(forced.isError).toBe(true);
    expect(forced.content[0]!.text).toMatch(/^invalid_request: /);
    expect(forced.content[0]!.text).not.toContain(key);
    expect(await versionsOf(c, 'leaky-skill')).toEqual([]);
    expect(readFileSync(join(p.home, 'activity.log'), 'utf8')).not.toContain(key);
  });

  it('with no developer set on a local catalog, it says so in the local words (set it with setup, never pick one); nothing stored', async () => {
    const { p, c, s } = await setup({});
    const dir = folder(p, 'nobodys-skill');
    const r = await s.call(P, { folder: dir });
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([{ type: 'text', text: S.word('errors').unauthenticated_local }]);
    expect(r.content[0]!.text).not.toBe(renderError(S, new CatalogError('unauthenticated', {})));
    expect(await versionsOf(c, 'nobodys-skill')).toEqual([]);
  });

  it('a folder identical to the latest version: nothing to publish, no new version', async () => {
    const { p, c, s } = await setup();
    const dir = folder(p, 'steady-skill');
    const first = await s.call(P, { folder: dir });
    await s.call(P, { folder: dir, ...step2In(first.content[0]!.text) });
    const again = await s.call(P, { folder: dir });
    expect(again.isError).toBeUndefined();
    expect(again.content[0]!.text).toMatch(/steady-skill/);
    expect(await versionsOf(c, 'steady-skill')).toEqual([1]);
  });
});

// The folder helper's own check: what it writes is what the tests above think it wrote.
it('the test folder holds SKILL.md, the script and the whole ignore list', () => {
  const p = place();
  const dir = folder(p, 'probe-skill');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [relative(dir, join(d, n))]));
  expect(walk(dir).sort()).toEqual(['SKILL.md', 'scripts/run.sh', ...IGNORED].sort());
});
