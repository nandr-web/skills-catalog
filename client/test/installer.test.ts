// The installer (contract §3, §4.5, §5.3; golden/histories.yaml installer and gate). It installs from bytes it checked,
// computes every flag itself (a first install is an update from nothing), holds a flagged change until the person's
// yes, never overwrites or shadows what it didn't install, and records what it did in the lock.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CatalogError, Surface, actAs, reasons, renderError, type Catalog } from '@skills-catalog/core';
import { checkTree, diffTrees, fingerprint, sha256Hex, type Mode } from '@skills-catalog/core/skill-tree';
import { describe, expect, it } from 'vitest';
import { contextFor, perform, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { readLock } from '../src/machine/lock.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Surface.load();
const AUTO_DEFAULT = S.word('policy_name').auto + S.word('policy_source').default;
const run = (op: string) => MACHINE_RUNS[op]!;
const install = run('install_shared_skill');
const update = run('update_installed_skills');
const accept = run('accept_held_update');
const list = run('list_installed_skills');
const policy = run('set_skill_update_policy');

type File = { path: string; text: string; mode?: string };

function ctxFor(p: Place, o: { face?: 'mcp' | 'cli'; catalog?: (c: Catalog) => Catalog } = {}): Context {
  const settings = settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome }, join(p.dir, 'project'));
  const { ctx } = contextFor(settings, S, o.face ?? 'mcp');
  if (!o.catalog) return ctx;
  const wrap = o.catalog;
  return { ...ctx, catalog: async () => wrap(await ctx.catalog()) };
}

const userSkills = (p: Place) => join(p.osHome, '.claude', 'skills');
const projectSkills = (p: Place) => join(p.dir, 'project', '.claude', 'skills');

async function publish(p: Place, name: string, files: File[], as = 'ana'): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(name, files), actAs(as));
  } finally {
    c.close();
  }
}

const plain = (name: string, body = 'Body.\n'): File[] => [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`, body) }];
const withScript = (name: string): File[] => [...plain(name, 'Body, with a script.\n'), { path: 'scripts/run.sh', text: '#!/bin/sh\necho run\n', mode: '0755' }];

const refusal = async (fn: () => Promise<unknown>): Promise<CatalogError> => {
  try {
    await fn();
  } catch (e) {
    if (e instanceof CatalogError) return e;
    throw e;
  }
  throw new Error('expected a CatalogError');
};

const confirmOf = (text: string) => /confirm "([^"]+)"/.exec(text)?.[1];
const tree = (dir: string, rel = ''): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, tree(dir, r));
    else out[`${r} ${(statSync(join(dir, r)).mode & 0o777).toString(8)}`] = readFileSync(join(dir, r), 'utf8');
  }
  return out;
};
const lockOf = (p: Place) => readLock(p.home).skills;
const nothingStaged = (p: Place) => !existsSync(join(p.home, 'staging')) || readdirSync(join(p.home, 'staging')).length === 0;

const fingerprintOf = (files: File[]) => fingerprint(files.map((f) => ({ path: f.path, mode: (f.mode ?? '0644') as Mode, sha256: sha256Hex(Buffer.from(f.text)) })));

// A catalog that sends other bytes than it should. Planted: a version stored before today's rules, so the catalog's
// versions list and its fetch reply agree on the planted bytes' fingerprint. With `fetchOnly`, only the fetch reply is
// altered (bytes, and the fingerprint claimed next to them unless given), while the versions list keeps the real one.
// `publisher` renames a version's publisher in the versions list; `version` relabels the fetch reply's version.
type Planted = { files?: File[]; fingerprint?: string; fetchOnly?: boolean; publisher?: string; version?: number };
function serving(plant: (name: string, version: number) => Planted | undefined): (c: Catalog) => Catalog {
  return (c) =>
    new Proxy(c, {
      get(target, prop, receiver) {
        if (prop === 'fetch') {
          return async (input: { name: string; version: number }) => {
            const real = await target.fetch(input);
            const p = plant(input.name, input.version);
            if (!p) return real;
            const out = { ...real, ...(p.version !== undefined ? { version: p.version } : {}) };
            if (!p.files) return out;
            const rows = p.files.map((f) => ({ path: f.path, mode: (f.mode ?? '0644') as Mode, content_base64: Buffer.from(f.text).toString('base64') }));
            return { ...out, files: rows, fingerprint: p.fingerprint ?? fingerprintOf(p.files) };
          };
        }
        if (prop === 'versions') {
          return async (input: { name: string; cursor?: string }) => {
            const real = await target.versions(input);
            const versions = real.versions.map((v) => {
              const p = plant(input.name, v.version);
              if (!p) return v;
              return { ...v, ...(p.files && !p.fetchOnly ? { fingerprint: p.fingerprint ?? fingerprintOf(p.files) } : {}), ...(p.publisher ? { publisher: p.publisher } : {}) };
            });
            return { ...real, versions };
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
}

describe('install (contract §3 install_shared_skill)', () => {
  it('installs a skill that can run nothing new: the files byte for byte, the lock entry, the words', async () => {
    const p = place();
    await publish(p, 'notes-helper', [...plain('notes-helper'), { path: 'reference.md', text: 'More.\n' }]);
    const r = await install(ctxFor(p), { name: 'notes-helper' });
    const dest = join(userSkills(p), 'notes-helper');
    expect(tree(dest)).toEqual({ 'SKILL.md 644': skillMd('notes-helper', 'The notes-helper skill.'), 'reference.md 644': 'More.\n' });
    expect(r.text).toBe(
      S.format(S.word('install.done'), { name: 'notes-helper', version: 1, path: JSON.stringify(dest), policy: AUTO_DEFAULT }) + '\n' + S.format(S.word('install.live'), { name: 'notes-helper' }),
    );
    expect(r.result).toBe(S.doc.log.result.install.installed);
    const e = lockOf(p)[dest]!;
    expect(e).toMatchObject({ name: 'notes-helper', target: 'user', version: 1, publisher: 'ana', path: dest, catalog: p.catalogUrl, accepted: [] });
    expect(e.fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(nothingStaged(p)).toBe(true);
    expect((statSync(join(p.home, 'lock.json')).mode & 0o777).toString(8)).toBe('600');
  });

  it('a project install goes into the project; a version can be named', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    await publish(p, 'notes-helper', plain('notes-helper', 'Second.\n'));
    await install(ctxFor(p), { name: 'notes-helper', version: 1, target: 'project' });
    expect(readFileSync(join(projectSkills(p), 'notes-helper', 'SKILL.md'), 'utf8')).toBe(skillMd('notes-helper', 'The notes-helper skill.'));
    expect(existsSync(join(userSkills(p), 'notes-helper'))).toBe(false);
  });

  it('holds a first install that adds something that can run, writes nothing, and takes it on the yes with the same flags', async () => {
    const p = place();
    await publish(p, 'runner', withScript('runner'));
    const ctx = ctxFor(p);
    const held = await install(ctx, { name: 'runner' });
    const confirm = confirmOf(held.text)!;
    expect(held.text).toBe(S.format(S.word('install.held'), { name: 'runner', version: 1, reasons: S.format(S.word('update.reason.runnable_file'), { path: 'scripts/run.sh' }), confirm, flags: '["runnable_file"]' }));
    expect(held.result).toBe(S.doc.log.result.install.held);
    expect(existsSync(join(userSkills(p), 'runner'))).toBe(false);
    expect(lockOf(p)).toEqual({});

    // The flags are compared as a set of kinds: one missing or extra is a conflict, and nothing changes.
    for (const flags of [[], ['runnable_file', 'new_publisher']]) {
      const e = await refusal(() => accept(ctx, { name: 'runner', confirm, flags }));
      expect(e.code).toBe('conflict');
      expect(renderError(S, e)).toBe(S.format(S.word('errors.accept_conflict'), { name: 'runner' }));
    }
    expect(existsSync(join(userSkills(p), 'runner'))).toBe(false);

    const taken = await accept(ctx, { name: 'runner', confirm, flags: ['runnable_file', 'runnable_file'] });
    const dest = join(userSkills(p), 'runner');
    expect(taken.text).toBe(S.format(S.word('install.installed_after_yes'), { name: 'runner', version: 1, path: JSON.stringify(dest), policy: AUTO_DEFAULT }));
    expect(taken.result).toBe(S.doc.log.result.accept);
    expect(tree(dest)['scripts/run.sh 755']).toBe('#!/bin/sh\necho run\n');
    expect(lockOf(p)[dest]!.accepted).toEqual([{ version: 1, flags: ['runnable_file'] }]);
  });

  it('the CLI face tells the person to take it in their own terminal', async () => {
    const p = place();
    await publish(p, 'runner', withScript('runner'));
    const held = await install(ctxFor(p, { face: 'cli' }), { name: 'runner' });
    expect(held.text).toBe(S.format(S.word('install.held_cli'), { name: 'runner', version: 1, reasons: S.format(S.word('update.reason.runnable_file'), { path: 'scripts/run.sh' }) }));
  });

  it('a held install is a conflict once a newer version arrives', async () => {
    const p = place();
    await publish(p, 'runner', withScript('runner'));
    const ctx = ctxFor(p);
    const confirm = confirmOf((await install(ctx, { name: 'runner' })).text)!;
    await publish(p, 'runner', [...withScript('runner'), { path: 'more.md', text: 'x\n' }]);
    expect((await refusal(() => accept(ctx, { name: 'runner', confirm, flags: ['runnable_file'] }))).code).toBe('conflict');
    expect(existsSync(join(userSkills(p), 'runner'))).toBe(false);
  });

  it('never overwrites or shadows what it did not install, and never installs through a link', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const ctx = ctxFor(p);
    const handMade = join(userSkills(p), 'notes-helper');
    mkdirSync(handMade, { recursive: true });
    writeFileSync(join(handMade, 'SKILL.md'), 'mine\n');
    expect((await refusal(() => install(ctx, { name: 'notes-helper' }))).data).toEqual({ path: handMade });
    expect((await refusal(() => install(ctx, { name: 'notes-helper' }))).code).toBe('exists_untracked');
    // The same name untracked in the other target: installing would shadow it for the assistant.
    const e = await refusal(() => install(ctx, { name: 'notes-helper', target: 'project' }));
    expect([e.code, e.data]).toEqual(['name_in_use', { path: handMade }]);
    expect(readFileSync(join(handMade, 'SKILL.md'), 'utf8')).toBe('mine\n');

    const q = place();
    await publish(q, 'notes-helper', plain('notes-helper'));
    const command = join(q.dir, 'project', '.claude', 'commands', 'notes-helper.md');
    mkdirSync(join(command, '..'), { recursive: true });
    writeFileSync(command, 'a command\n');
    const c = await refusal(() => install(ctxFor(q), { name: 'notes-helper' }));
    expect([c.code, c.data]).toEqual(['name_in_use', { path: command }]);
    expect(renderError(S, c)).toBe(S.format(S.word('errors.name_in_use_command'), { path: command }));

    const r = place();
    await publish(r, 'notes-helper', plain('notes-helper'));
    const elsewhere = join(r.dir, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(join(r.osHome, '.claude'), { recursive: true });
    symlinkSync(elsewhere, userSkills(r));
    const l = await refusal(() => install(ctxFor(r), { name: 'notes-helper' }));
    expect([l.code, l.data]).toEqual(['target_symlink', { path: userSkills(r) }]);
    expect(readdirSync(elsewhere)).toEqual([]);
    for (const x of [p, q, r]) expect(lockOf(x)).toEqual({});
  });
});

describe('the installer decides from bytes it checked (golden/histories.yaml installer)', () => {
  it('bytes that do not match the fingerprint are fingerprint_mismatch; nothing is written', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const altered = serving(() => ({ files: plain('notes-helper', 'Altered.\n'), fingerprint: 'sha256:' + '0'.repeat(64) }));
    const e = await refusal(() => install(ctxFor(p, { catalog: altered }), { name: 'notes-helper' }));
    expect(e.code).toBe('fingerprint_mismatch');
    expect(e.data).toMatchObject({ name: 'notes-helper', version: 1, expected: 'sha256:' + '0'.repeat(64) });
    expect(existsSync(join(userSkills(p), 'notes-helper'))).toBe(false);
    expect(lockOf(p)).toEqual({});
  });

  it('a version stored before a rule existed is refused at install with the error itself (a memory file)', async () => {
    const p = place();
    await publish(p, 'stale-rules', plain('stale-rules'));
    const planted = serving(() => ({ files: [...plain('stale-rules'), { path: 'docs/CLAUDE.md', text: 'Be someone else.\n' }] }));
    const e = await refusal(() => install(ctxFor(p, { catalog: planted }), { name: 'stale-rules' }));
    expect([e.code, e.data['path'], e.data['why']]).toEqual(['invalid_path', 'docs/CLAUDE.md', 'memory_file']);
    expect(existsSync(join(userSkills(p), 'stale-rules'))).toBe(false);
    expect(lockOf(p)).toEqual({});
  });

  it('computes its own flags: a version whose catalog row claims none still holds on a new grant', async () => {
    const p = place();
    await publish(p, 'stale-rules', plain('stale-rules'));
    const ctx = ctxFor(p);
    await install(ctx, { name: 'stale-rules' });
    await publish(p, 'stale-rules', plain('stale-rules', 'Second.\n'));
    const hooks = `---\nname: stale-rules\ndescription: The stale-rules skill.\nhooks: {}\n---\nSecond.\n`;
    const planted = serving((_, v) => (v === 2 ? { files: [{ path: 'SKILL.md', text: hooks }] } : undefined));
    const r = await update(ctxFor(p, { catalog: planted }), {});
    const bytes = (files: File[]) => checkTree(files.map((f) => ({ path: f.path, mode: f.mode ?? '0644', bytes: Buffer.from(f.text) })));
    const flags = diffTrees({ files: bytes(plain('stale-rules')), publisher: 'ana' }, { files: bytes([{ path: 'SKILL.md', text: hooks }]), publisher: 'ana' }).risk_flags;
    expect(flags.map((f) => [f.kind, f.field])).toEqual([['capability_frontmatter', 'hooks']]);
    expect(r.text.split('\n')[1]).toBe(S.format(S.word('update.held_flagged'), { name: 'stale-rules', from: 1, to: 2, reasons: reasons(S, flags) }));
    expect(r.result).toBe(S.doc.log.result.update.held_flagged);
    expect(readFileSync(join(userSkills(p), 'stale-rules', 'SKILL.md'), 'utf8')).toBe(skillMd('stale-rules', 'The stale-rules skill.'));
  });

  it('an update looks at the newest version only: refused, the lock and the installed copy stay as they are', async () => {
    const p = place();
    await publish(p, 'stale-rules', plain('stale-rules'));
    await install(ctxFor(p), { name: 'stale-rules' });
    await publish(p, 'stale-rules', plain('stale-rules', 'Clean second.\n'));
    await publish(p, 'stale-rules', plain('stale-rules', 'Third.\n'));
    const lockBefore = readFileSync(join(p.home, 'lock.json'), 'utf8');
    const planted = serving((_, v) => (v === 3 ? { files: [...plain('stale-rules', 'Third.\n'), { path: 'docs/CLAUDE.md', text: 'x\n' }] } : undefined));
    const r = await update(ctxFor(p, { catalog: planted }), {});
    expect(r.text).toBe(
      [
        S.format(S.word('update.header'), { checked: 1 }),
        S.format(S.word('update.refused'), { name: 'stale-rules', from: 1, to: 3, reason: `"docs/CLAUDE.md" ${S.word('errors.why.memory_file')}` }),
      ].join('\n'),
    );
    expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);
    expect(readFileSync(join(userSkills(p), 'stale-rules', 'SKILL.md'), 'utf8')).toBe(skillMd('stale-rules', 'The stale-rules skill.'));
  });

  // §5.3 step 1: the fingerprint a version's bytes are checked against is the catalog's record of that version (its
  // versions list), never the one sent next to the bytes, which a catalog serving other bytes would send to match them.
  it('checks the bytes against the versions list, not the fingerprint sent with them: install, update and accept', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const other = { files: withScript('notes-helper'), fetchOnly: true };
    const e = await refusal(() => install(ctxFor(p, { catalog: serving(() => other) }), { name: 'notes-helper' }));
    expect(e.code).toBe('fingerprint_mismatch');
    expect(e.data).toMatchObject({ name: 'notes-helper', version: 1, expected: fingerprintOf(plain('notes-helper')), got: fingerprintOf(withScript('notes-helper')) });
    expect(existsSync(join(userSkills(p), 'notes-helper'))).toBe(false);
    expect(lockOf(p)).toEqual({});

    const ctx = ctxFor(p);
    await install(ctx, { name: 'notes-helper' });
    await publish(p, 'notes-helper', plain('notes-helper', 'Second.\n'));
    const lockBefore = readFileSync(join(p.home, 'lock.json'), 'utf8');
    const r = await update(ctxFor(p, { catalog: serving((_, v) => (v === 2 ? { files: plain('notes-helper', 'Altered.\n'), fetchOnly: true } : undefined)) }), {});
    expect(r.text.split('\n')[1]).toBe(S.format(S.word('update.refused_fingerprint'), { name: 'notes-helper', from: 1, to: 2 }));
    expect(readFileSync(join(p.home, 'lock.json'), 'utf8')).toBe(lockBefore);

    const q = place();
    await publish(q, 'runner', withScript('runner'));
    const confirm = confirmOf((await install(ctxFor(q), { name: 'runner' })).text)!;
    const swapped = serving(() => ({ files: [...withScript('runner'), { path: 'more.md', text: 'x\n' }], fetchOnly: true }));
    expect((await refusal(() => accept(ctxFor(q, { catalog: swapped }), { name: 'runner', confirm, flags: ['runnable_file'] }))).code).toBe('fingerprint_mismatch');
    expect(existsSync(join(userSkills(q), 'runner'))).toBe(false);
  });

  it('a fetch reply naming another version than the one asked for is refused, and nothing is written', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const e = await refusal(() => install(ctxFor(p, { catalog: serving(() => ({ version: 7 })) }), { name: 'notes-helper' }));
    expect(e.code).toBe('fingerprint_mismatch');
    expect(e.data).toMatchObject({ name: 'notes-helper', version: 1 });
    expect(existsSync(join(userSkills(p), 'notes-helper'))).toBe(false);
    expect(lockOf(p)).toEqual({});
  });

  // §5.3 step 3: an installed copy the installer can't check today counts as no version at all, but the publishers are
  // still compared, since no rule changes who published.
  it('an installed copy that fails today’s check still compares publishers: a new publisher holds the update', async () => {
    const p = place();
    await publish(p, 'stale-rules', plain('stale-rules'));
    const ctx = ctxFor(p);
    await install(ctx, { name: 'stale-rules' });
    await publish(p, 'stale-rules', plain('stale-rules', 'Second.\n'));
    const catalog = serving((_, v) => (v === 1 ? { files: [...plain('stale-rules'), { path: 'docs/CLAUDE.md', text: 'x\n' }] } : { publisher: 'bob' }));
    const r = await update(ctxFor(p, { catalog }), {});
    const bytes = (files: File[]) => checkTree(files.map((f) => ({ path: f.path, mode: f.mode ?? '0644', bytes: Buffer.from(f.text) })));
    const flags = diffTrees({ files: [], publisher: 'ana' }, { files: bytes(plain('stale-rules', 'Second.\n')), publisher: 'bob' }).risk_flags;
    expect(flags.map((f) => f.kind)).toContain('new_publisher');
    expect(r.text.split('\n')[1]).toBe(S.format(S.word('update.held_flagged'), { name: 'stale-rules', from: 1, to: 2, reasons: reasons(S, flags) }));
    expect(r.result).toBe(S.doc.log.result.update.held_flagged);
    expect(readFileSync(join(userSkills(p), 'stale-rules', 'SKILL.md'), 'utf8')).toBe(skillMd('stale-rules', 'The stale-rules skill.'));

    // The yes takes it with the same flags, new_publisher included.
    const confirm = confirmOf(r.text.split('\n')[2]!)!;
    const kinds = [...new Set(flags.map((f) => f.kind))];
    expect((await refusal(() => accept(ctxFor(p, { catalog }), { name: 'stale-rules', confirm, flags: kinds.filter((k) => k !== 'new_publisher') }))).code).toBe('conflict');
    await accept(ctxFor(p, { catalog }), { name: 'stale-rules', confirm, flags: kinds });
    expect(lockOf(p)[join(userSkills(p), 'stale-rules')]).toMatchObject({ version: 2, publisher: 'bob' });
  });
});

describe('update (contract §3 update_installed_skills, §5.3)', () => {
  it('updates a text-only change, holds one that adds a script until the yes, and says what is up to date', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    await publish(p, 'runner', plain('runner'));
    await publish(p, 'steady', plain('steady'));
    const ctx = ctxFor(p);
    for (const name of ['notes-helper', 'runner', 'steady']) await install(ctx, { name });
    await publish(p, 'notes-helper', plain('notes-helper', 'Second.\n'));
    await publish(p, 'runner', withScript('runner'));

    const dry = await update(ctx, { dry_run: true });
    expect(dry.text.split('\n')[1]).toBe(S.format(S.word('update.would_update'), { name: 'notes-helper', from: 1, to: 2, changes: '"SKILL.md" changed' }));
    expect(lockOf(p)[join(userSkills(p), 'notes-helper')]!.version).toBe(1);

    const r = await update(ctx, {});
    const lines = r.text.split('\n');
    expect(lines[0]).toBe(S.format(S.word('update.header'), { checked: 3 }));
    expect(lines[1]).toBe(S.format(S.word('update.updated'), { name: 'notes-helper', from: 1, to: 2, changes: '"SKILL.md" changed' }));
    expect(lines[2]).toBe(S.format(S.word('update.held_flagged'), { name: 'runner', from: 1, to: 2, reasons: S.format(S.word('update.reason.runnable_file'), { path: 'scripts/run.sh' }) }));
    const confirm = confirmOf(lines[3]!)!;
    expect(lines[3]).toBe(S.format(S.word('update.held_next'), { name: 'runner', from: 1, confirm, flags: '["runnable_file"]' }));
    expect(lines[4]).toBe(S.format(S.word('update.unchanged'), { n: 1 }));
    expect(r.result).toBe(S.doc.log.result.update.held_flagged);
    expect(readFileSync(join(userSkills(p), 'notes-helper', 'SKILL.md'), 'utf8')).toContain('Second.');
    expect(existsSync(join(userSkills(p), 'runner', 'scripts'))).toBe(false);

    const dest = join(userSkills(p), 'runner');
    const taken = await accept(ctx, { name: 'runner', confirm, flags: ['runnable_file'] });
    expect(taken.text).toBe(S.format(S.word('update.accepted'), { name: 'runner', from: 1, to: 2, path: JSON.stringify(dest) }));
    expect(lockOf(p)[dest]).toMatchObject({ version: 2, accepted: [{ version: 2, flags: ['runnable_file'] }] });
    expect(nothingStaged(p)).toBe(true);
  });

  it('follows the policy: pinned and tell-me-first skills stay; names limit it; a name not installed is not_installed', async () => {
    const p = place();
    for (const name of ['pinned-one', 'ask-first', 'auto-one']) await publish(p, name, plain(name));
    const ctx = ctxFor(p);
    for (const name of ['pinned-one', 'ask-first', 'auto-one']) await install(ctx, { name });
    await policy(ctx, { policy: 'pin', name: 'pinned-one' });
    await policy(ctx, { policy: 'notify', name: 'ask-first' });
    for (const name of ['pinned-one', 'ask-first', 'auto-one']) await publish(p, name, plain(name, 'Second.\n'));
    const r = await update(ctx, {});
    expect(r.text.split('\n')).toEqual([
      S.format(S.word('update.header'), { checked: 3 }),
      S.format(S.word('update.held_notify'), { name: 'ask-first', from: 1, to: 2 }),
      S.format(S.word('update.updated'), { name: 'auto-one', from: 1, to: 2, changes: '"SKILL.md" changed' }),
      S.format(S.word('update.held_pin'), { name: 'pinned-one', from: 1, to: 2 }),
    ]);
    expect(r.result).toBe(S.doc.log.result.update.held_notify);
    const e = await refusal(() => update(ctx, { names: ['auto-one', 'never-installed'] }));
    expect([e.code, e.data]).toEqual(['not_installed', { name: 'never-installed' }]);
    const one = await update(ctx, { names: ['pinned-one'] });
    expect(one.text.split('\n')[0]).toBe(S.format(S.word('update.header'), { checked: 1 }));
  });

  it('the default policy is set without a name; a skill with its own keeps it', async () => {
    const p = place();
    for (const name of ['a-skill', 'b-skill']) await publish(p, name, plain(name));
    const ctx = ctxFor(p);
    for (const name of ['a-skill', 'b-skill']) await install(ctx, { name });
    await policy(ctx, { policy: 'auto', name: 'a-skill' });
    await policy(ctx, { policy: 'pin' });
    for (const name of ['a-skill', 'b-skill']) await publish(p, name, plain(name, 'Second.\n'));
    const r = await update(ctx, {});
    expect(r.text).toContain(S.format(S.word('update.updated'), { name: 'a-skill', from: 1, to: 2, changes: '"SKILL.md" changed' }));
    expect(r.text).toContain(S.format(S.word('update.held_pin'), { name: 'b-skill', from: 1, to: 2 }));
    expect((await refusal(() => policy(ctx, { policy: 'pin', name: 'not-here' }))).code).toBe('not_installed');
  });

  it('the list of installed skills: version, latest, policy, same or behind', async () => {
    const p = place();
    for (const name of ['a-skill', 'b-skill']) await publish(p, name, plain(name));
    const ctx = ctxFor(p);
    for (const name of ['a-skill', 'b-skill']) await install(ctx, { name });
    await publish(p, 'b-skill', plain('b-skill', 'Second.\n'));
    const r = await list(ctx, {});
    const line = (name: string, state: string) => S.format(S.word('status.line'), { name, version: 1, state, policy: AUTO_DEFAULT });
    expect(r.text).toBe(
      [
        S.format(S.word('status.header'), { n: 2 }),
        line('a-skill', S.format(S.word('status.state.same'))),
        line('b-skill', S.format(S.word('status.state.behind'), { latest: 2 })),
        S.format(S.word('status.next_behind')),
      ].join('\n'),
    );
    expect(r.result).toBe(S.doc.log.result.status);
  });

  it('every face: an installer call goes through perform, with its log line', async () => {
    const p = place();
    await publish(p, 'notes-helper', plain('notes-helper'));
    const a = await perform(ctxFor(p), 'install_shared_skill', 'install_shared_skill', { name: 'notes-helper' });
    expect(a.isError).toBe(false);
    const log = readFileSync(join(p.home, 'activity.log'), 'utf8');
    expect(log).toContain('install_shared_skill');
    expect(log).toContain('notes-helper v1');
  });
});
