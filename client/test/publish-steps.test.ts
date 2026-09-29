// publish_skill_to_catalog's two steps (contract §3), driven by the QA goldens as they are: qa/golden/skills.yaml's
// publish_steps (step 2's checks, in their order, and the confirm's secret), request_checks, command_quoting and the
// skipped list's fixtures (hostile ignored-folders, skipped-cap). Nothing here fills in or changes an expected value.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CatalogError, Surface, actAs, renderError, shellQuote } from '@skills-catalog/core';
import { loadGolden } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { contextFor } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { SKIPPED_SHOWN } from '../src/machine/publish-folder.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request } from './seed.ts';
import { place, type Place } from './server.ts';

const skills = loadGolden('skills.yaml');
const histories = loadGolden('histories.yaml');
const S = Surface.load();
const publish = MACHINE_RUNS['publish_skill_to_catalog']!;
const AS = 'dev1';

const sub = (text: string, p: Place) => text.replaceAll('$SKILLS_HOME', p.home).replaceAll('$REAL', realpathSync(p.dir)).replaceAll('$RUN_ID', 'run').replaceAll('$RUN', p.dir);
const keyOf = (home: string) => join(home, 'confirm.key');

// A fixture's files: histories.yaml's versions (prc.v1) or skills.yaml's (skills.hostile.ignore-list).
function fixture(ref: string): Record<string, any> {
  if (ref.startsWith('skills.')) {
    const [, group, name] = ref.split('.');
    return skills[group!][name!].files;
  }
  return histories.versions[ref];
}
const nameOf = (files: Record<string, any>) => /^name: (\S+)$/m.exec(String(files['SKILL.md']))![1]!;

// Writes a fixture's files on disk, links, hard links and fifos included; a link or hard link into $RUN/outside finds the
// canary's secret there.
function plant(dir: string, files: Record<string, any>, p: Place): void {
  const canary = join(p.dir, 'outside', 'id_fake');
  mkdirSync(dirname(canary), { recursive: true });
  if (!existsSync(canary)) writeFileSync(canary, 'QA-SENTINEL-run\n');
  for (const [path, v] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    if (typeof v === 'string') writeFileSync(full, sub(v, p));
    else if (v.symlink) symlinkSync(sub(v.symlink, p), full);
    else if (v.hardlink) linkSync(sub(v.hardlink, p), full);
    else if (v.fifo) execFileSync('mkfifo', [full]);
    else {
      writeFileSync(full, v.text);
      if (v.mode) chmodSync(full, parseInt(v.mode, 8));
    }
  }
}

const ctxFor = (p: Place, home = p.home) => contextFor(settingsFrom({ SKILLS_HOME: home, SKILLS_CATALOG: p.catalogUrl, SKILLS_AS: AS }), S, 'mcp').ctx;

// The values a preview gives for step 2, read from its words.
function step2Of(text: string) {
  const m = /confirm "([^"]*)", name "([^"]*)", version (\d+), files (\d+) and flags (\[[^\]]*\])/.exec(text);
  if (!m) throw new Error(`no step-2 values in:\n${text}`);
  return { confirm: m[1]!, name: m[2]!, version: Number(m[3]), files: Number(m[4]), flags: JSON.parse(m[5]!) as string[] };
}

const refusal = async (fn: () => Promise<unknown>): Promise<CatalogError> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('expected a CatalogError');
};

async function latest(p: Place, name: string): Promise<number> {
  const c = await open(p);
  try {
    return (await c.versions({ name })).latest;
  } catch (e) {
    if (e instanceof CatalogError && e.code === 'not_found') return 0;
    throw e;
  } finally {
    c.close();
  }
}

async function publishDirect(p: Place, name: string, ref: string, as: string): Promise<{ created: boolean; version: number }> {
  const files = Object.entries(fixture(ref)).map(([path, v]) => (typeof v === 'string' ? { path, text: v } : { path, text: v.text, mode: v.mode }));
  const c = await open(p);
  try {
    return await c.publish(request(name, files), actAs(as));
  } finally {
    c.close();
  }
}

async function seedCatalog(p: Place, catalog: string): Promise<void> {
  if (catalog === 'empty') return;
  const m = /^histories\.(\w+)@v(\d+)$/.exec(catalog)!;
  const h = histories.histories?.[m[1]!] ?? histories[m[1]!];
  for (const step of h.steps.slice(0, Number(m[2]))) await publishDirect(p, h.name, step.publish, AS);
}

function keyLooks(home: string) {
  const st = lstatSync(keyOf(home));
  return { regular: st.isFile(), mode: (st.mode & 0o777).toString(8).padStart(4, '0'), bytes: st.size };
}

describe('publish_steps: step 2 checks the confirm\'s form, then the HMAC, then the latest (golden publish_steps)', () => {
  for (const c of skills.publish_steps.cases) {
    it(c.id, async () => {
      const p = place();
      await seedCatalog(p, c.catalog);
      const files = fixture(c.folder);
      const name = nameOf(files);
      const dir = join(p.dir, 'work', 'skills', name);
      plant(dir, files, p);
      for (const [link, target] of Object.entries<string>(c.links ?? {})) symlinkSync(target, sub(link, p));
      const given = c.folder_given_as ? sub(c.folder_given_as, p) : dir;
      const home = c.step1_in === 'other_skills_home' ? join(p.dir, 'other-home') : p.home;
      if (c.skills_home === 'fresh') expect(existsSync(keyOf(p.home))).toBe(false);

      const first = await publish(ctxFor(p, home), { folder: given, ...(c.message !== undefined ? { message: c.message } : {}) });
      const v = step2Of(first.text);
      if (c.step1_expect) {
        const { confirm_matches, ...values } = c.step1_expect;
        expect(v).toMatchObject(values);
        if (confirm_matches) expect(v.confirm).toMatch(new RegExp(confirm_matches));
      }
      const keyAfter = c.key_after ?? c.expect?.key_after;
      const keyBefore = existsSync(keyOf(p.home)) ? readFileSync(keyOf(p.home)) : undefined;
      const before = await latest(p, name);

      const b = c.between ?? {};
      if (b.edit) appendFileSync(join(dir, b.edit.path), b.edit.append);
      if (b.add) writeFileSync(join(dir, b.add.path), b.add.text);
      if (b.chmod) chmodSync(sub(b.chmod.path, p), parseInt(b.chmod.mode, 8));
      if (b.delete) rmSync(b.delete.startsWith('$') ? sub(b.delete, p) : join(dir, b.delete), { recursive: true });
      if (b.replace_with_symlink) {
        const key = sub(b.replace_with_symlink.path, p), target = sub(b.replace_with_symlink.target, p);
        writeFileSync(target, readFileSync(key)); // the same 32 bytes, outside
        rmSync(key);
        symlinkSync(target, key);
      }
      if (b.publish_direct) expect(await publishDirect(p, name, b.publish_direct, b.as)).toMatchObject(b.expect);
      const between = await latest(p, name);
      // restart: each call below builds its context anew, as a new server or CLI process would; only files persist.

      if (!c.step2) {
        if (keyAfter) expect(keyLooks(p.home)).toMatchObject({ regular: keyAfter.regular, mode: keyAfter.mode, bytes: keyAfter.bytes });
        if (c.storage_unchanged) expect(await latest(p, name)).toBe(before);
        return;
      }
      const s2 = c.step2 === 'as_given' ? {} : c.step2;
      const w = { ...(s2.with ?? {}) };
      if (w.confirm === 'hand_made') w.confirm = createHash('sha256').update(c.hand_made).digest('base64url');
      const args = {
        folder: s2.folder ? sub(s2.folder, p) : given,
        ...(c.message !== undefined ? { message: c.message } : {}),
        confirm: v.confirm, name: v.name, version: v.version, files: v.files, flags: v.flags,
        ...w,
      };
      const e = c.expect;
      if (e.error) {
        const err = await refusal(() => publish(ctxFor(p), args));
        const want: Record<string, unknown> = { code: e.error, name };
        if (e.field) Object.assign(want, { field: e.field, why: e.why });
        if (e.folder) want['folder'] = e.folder === 'realpath' ? realpathSync(dir) : sub(e.folder, p);
        if (e.latest !== undefined) want['latest'] = e.latest;
        if (e.error === 'invalid_request') delete want['name'];
        expect(err.toJSON()).toMatchObject(want);
        if (e.storage_unchanged) expect(await latest(p, name)).toBe(before);
        if (e.storage_unchanged_since_between) expect(await latest(p, name)).toBe(between);
      } else {
        const done = await publish(ctxFor(p), args);
        expect(done.text).toBe(S.format(S.word('publish.published'), { name, version: e.version }));
        expect(await latest(p, name)).toBe(e.version);
      }
      if (keyAfter) {
        expect(keyLooks(p.home)).toMatchObject({ regular: keyAfter.regular, mode: keyAfter.mode, bytes: keyAfter.bytes });
        if (keyAfter.changed) expect(readFileSync(keyOf(p.home)).equals(keyBefore!)).toBe(false);
      }
      if (e.outside_unchanged) expect(readFileSync(sub(b.replace_with_symlink.target, p)).equals(keyBefore!)).toBe(true);
    });
  }
});

describe('a publish\'s request checks (golden publish_steps.request_checks)', () => {
  for (const c of skills.publish_steps.request_checks) {
    it(c.id, async () => {
      const p = place();
      const files = fixture(c.send.folder);
      const dir = join(p.dir, 'work', 'skills', nameOf(files));
      plant(dir, files, p);
      const send = { ...c.send, folder: dir };
      if (send.confirm === 'step1') send.confirm = step2Of((await publish(ctxFor(p), { folder: dir })).text).confirm;
      const err = await refusal(() => publish(ctxFor(p), send));
      const want: Record<string, unknown> = { code: c.expect.error };
      if (c.expect.field) Object.assign(want, { field: c.expect.field, why: c.expect.why });
      if (c.expect.folder === 'realpath') want['folder'] = realpathSync(dir);
      expect(err.toJSON()).toMatchObject(want);
      expect(await latest(p, nameOf(files))).toBe(0);
    });
  }
});

describe('the skipped list: ignored folders once and never walked, at most 50 entries (golden hostile)', () => {
  for (const id of ['ignore-list', 'ignored-folders', 'skipped-cap']) {
    it(id, async () => {
      const p = place();
      const f = skills.hostile[id];
      const dir = join(p.dir, 'work', 'skills', id);
      plant(dir, f.files, p);
      const preview = await publish(ctxFor(p), { folder: dir });
      // The skipped line, read back from the preview's own template: its count, its JSON-quoted entries, and the rest.
      const [before] = S.word('publish.preview').split('{n_skip}').at(-2)!.split('\n').slice(-1);
      const line = preview.text.split('\n').find((l) => l.startsWith(before!))!;
      const listed = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
      const x = f.expect;
      const more = x.skipped_more === undefined || x.skipped_more === 'absent' ? 0 : x.skipped_more;
      expect(listed.length).toBeLessThanOrEqual(SKIPPED_SHOWN);
      if (x.skipped_reported) expect(listed).toEqual(x.skipped_reported);
      if (x.skipped_reported_count !== undefined) expect(listed.length).toBe(x.skipped_reported_count);
      if (x.skipped_reported_first !== undefined) expect(listed[0]).toBe(x.skipped_reported_first);
      if (x.skipped_reported_last !== undefined) expect(listed.at(-1)).toBe(x.skipped_reported_last);
      for (const gone of x.skipped_reported_excludes ?? []) expect(listed).not.toContain(gone);
      expect(line.startsWith(`${before}${listed.length + more})`)).toBe(true);
      expect(line.endsWith(more ? S.format(S.word('publish.skip_more'), { n: more }) : `"${listed.at(-1)}"`)).toBe(true);
      const v = step2Of(preview.text);
      await publish(ctxFor(p), { folder: dir, ...v });
      const c = await open(p);
      try {
        const got = await c.fetch({ name: id, version: 1 });
        expect(got.files.map((x) => x.path).sort()).toEqual([...f.expect.published_paths].sort());
        if (f.expect.sentinel_must_not_leak) expect(JSON.stringify(got)).not.toContain(Buffer.from('QA-SENTINEL').toString('base64').slice(0, 12));
      } finally {
        c.close();
      }
      if (f.expect.sentinel_must_not_leak) expect(preview.text).not.toContain('QA-SENTINEL');
    });
  }
});

// POSIX shell words, as sh splits them: '…' literal, \x outside quotes, "…" with \ before " $ ` \.
function shellWords(line: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      cur = (cur ?? '') + line.slice(i + 1, end);
      i = end;
    } else if (ch === '\\') cur = (cur ?? '') + line[++i]!;
    else if (ch === '"') {
      cur = cur ?? '';
      for (i++; line[i] !== '"'; i++) cur += line[i] === '\\' && '"$`\\'.includes(line[i + 1]!) ? line[++i] : line[i];
    } else if (/\s/.test(ch)) {
      if (cur !== null) out.push(cur);
      cur = null;
    } else cur = (cur ?? '') + ch;
  }
  if (cur !== null) out.push(cur);
  return out;
}

// No sentence names a folder in a command today (the CLI has no publish yet), so the folder cases check the renderer's
// shell quoting itself: each path is one word to a real shell, which prints it back as it is and runs nothing in it.
describe('a folder in a command the person is told to run is one shell word (golden command_quoting)', () => {
  for (const c of skills.command_quoting.cases.filter((x: any) => x.folder)) {
    it(c.id, () => {
      const p = place();
      mkdirSync(join(p.dir, 'work'), { recursive: true });
      const dir = sub(c.folder, p);
      const arg = shellQuote(dir);
      expect(shellWords(arg)).toEqual([dir]);
      expect(execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${arg}`], { cwd: join(p.dir, 'work'), encoding: 'utf8' })).toBe(`${dir}\n`);
      if (c.expect.quoted !== undefined && p.dir === p.dir.replace(/[^A-Za-z0-9@%+=:,./_-]/g, '')) expect(arg.startsWith("'"), arg).toBe(c.expect.quoted);
      if (c.expect.contains) expect(arg).toContain(c.expect.contains);
      if (c.expect.ends_with) expect(arg.endsWith(c.expect.ends_with)).toBe(true);
      if (c.expect.marker_never_created) expect(existsSync(sub(c.expect.marker_never_created, p))).toBe(false);
    });
  }
});
