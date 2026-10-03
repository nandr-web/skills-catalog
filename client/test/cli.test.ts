// The CLI face (contract §1, §3): the API's operations as commands, named as the words file's CLI names them. Skill
// names are positional; every other input is --field-name (a list one comma-separated value). Results go to stdout and
// errors to stderr, with "(Acting as …)" last on both while a developer is set; exit 0 done, 1 an error, 3 needs the
// person. The person-only step (update <name> --accept) asks in the person's own terminal and refuses without one.
// Each command's own behaviour: cli-commands.test.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actAs, renderError, CatalogError, Words } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { readLock } from '../src/machine/lock.ts';
import { cli, S } from './cli-io.ts';
import { open, request, seed, skillMd } from './seed.ts';
import { childEnv, place, type Place } from './server.ts';

const skills = (p: Place) => join(p.osHome, '.claude', 'skills');

describe('the CLI face', () => {
  it('names its commands as the words file does: every ${op} a CLI result shows is a command, never a tool name', () => {
    const cliNames = Object.values(S.names);
    expect(cliNames).toContain('skills-catalog install <name>');
    expect(cliNames).toContain('skills-catalog update <name> --accept');
    const held = S.word('install.held') as string;
    expect(held).toContain('{command}');
    expect(held).not.toMatch(/accept_held_update/);
  });

  it('serves the catalog\'s and the installer\'s commands, publish, the MCP server, the local page, setup, teardown and sign-in; preview is still to come', async () => {
    const p = place();
    const u = await cli(p, ['frobnicate']);
    expect(u.err.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim().split(' ')[1])).toEqual(['search', 'read', 'versions', 'diff', 'install', 'update', 'list', 'policy', 'publish', 'update', 'stats', 'review', 'mcp', 'serve', 'setup', 'teardown', 'login', 'logout']);
    for (const word of ['preview']) {
      const r = await cli(p, [word, 'x']);
      expect([r.code, r.err], word).toEqual([1, u.err]);
    }
  });

  it('a word that names something every object has (constructor, __proto__, …) is no command: the usage, exit 1', async () => {
    const p = place();
    const u = await cli(p, ['frobnicate']);
    for (const word of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      for (const argv of [[word], [word, 'x', '--as', 'dev1']]) {
        const r = await cli(p, argv);
        expect([r.code, r.out, r.err], argv.join(' ')).toEqual([1, '', u.err]);
      }
    }
  });

  it('list with nothing installed says how to add one', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['list']);
    expect(r.code).toBe(0);
    expect(r.out.trimEnd()).toBe(S.format(S.word('status.empty')));
    expect(r.out).toContain('skills-catalog install <name>');
  });

  it('install takes a version and a target as flags', async () => {
    const p = place();
    await seed(p);
    const r = await cli(p, ['install', 'release-notes-kit', '--version', '1', '--target', 'project']);
    expect(r.code).toBe(0);
    expect(readFileSync(join(p.dir, 'project', '.claude', 'skills', 'release-notes-kit', 'SKILL.md'), 'utf8')).toBe(skillMd('release-notes-kit', 'Draft release notes from merged pull requests.'));
  });

  // Review P7.4: an earlier version over a newer installed copy says it replaced the newer one (it was silent).
  it('install of an earlier version over a newer copy says which newer version it replaced, in a terminal and without one', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    expect((await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['y'] })).code).toBe(0);
    const tty = await cli(p, ['install', 'release-notes-kit', '--version', '1'], { tty: true, person: true });
    expect(tty.code).toBe(0);
    expect(tty.out).toContain(S.format(S.word('person.install.done_older'), { name: 'release-notes-kit', version: 1, from: 2 }));
    const q = place();
    await seed(q);
    await cli(q, ['install', 'release-notes-kit']);
    await cli(q, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['y'] });
    const plain = await cli(q, ['install', 'release-notes-kit', '--version', '1']);
    expect(plain.code).toBe(0);
    expect(plain.out).toContain(S.format(S.word('install.replaced_newer'), { from: 2 }));
  });

  // The B validator (P6.6/V4.2): several names, or a miss among them, got the assistant's text in a terminal.
  it('read of several names, and of a name with a file typed after it, is laid out for the person: no data fence, no error code', async () => {
    const p = place();
    await seed(p);
    const two = await cli(p, ['read', 'release-notes-kit', 'sql-migration-helper'], { tty: true, person: true });
    expect(two.code).toBe(0);
    expect(two.out).toMatch(/^release-notes-kit v2, published by ana on /m);
    expect(two.out).toMatch(/^sql-migration-helper v1, published by ben on /m);
    expect(two.out).toContain(S.format(S.word('person.read.as_written'), { publisher: 'ana' }));
    expect(two.out).toContain(S.format(S.word('person.read.as_written'), { publisher: 'ben' }));
    expect(two.out).not.toContain('unless the user asks');
    const file = await cli(p, ['read', 'release-notes-kit', 'nope.md'], { tty: true, person: true });
    expect(file.out).not.toMatch(/invalid_name:|unless the user asks/);
    expect(file.out).toContain(S.format(S.word('person.read.path_hint'), { skill: 'release-notes-kit', path: 'nope.md' }));
  });

  // The B validator: the diff named the field ("front matter description:"); the plain list didn't say which copy is
  // the project's when a skill is in both (review P11.5).
  it('diff names a known front-matter field in words; list says which copy is only for this project', async () => {
    const p = place();
    await seed(p);
    const d = await cli(p, ['diff', 'release-notes-kit', '--from', '1', '--to', '2'], { tty: true, person: true });
    expect(d.out).toContain('• Description: Draft release notes from merged pull requests. → Draft release notes and a changelog from merged pull requests.');
    expect(d.out).not.toContain('front matter description');
    await cli(p, ['install', 'release-notes-kit', '--version', '1']);
    await cli(p, ['install', 'release-notes-kit', '--version', '1', '--target', 'project']);
    const l = await cli(p, ['list']);
    const lines = l.out.split('\n').filter((x) => x.includes('release-notes-kit'));
    expect(lines).toHaveLength(2);
    expect(lines.filter((x) => x.includes(S.word('status.where_project') as string))).toHaveLength(1);
  });

  it('install from a hosted catalog that can\'t be reached fails and writes nothing, and says which catalog (not a bug: review V4.3)', async () => {
    const p = place();
    const catalog = 'https://127.0.0.1:1';
    const r = await cli(p, ['install', 'release-notes-kit'], { env: { SKILLS_CATALOG: catalog } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('catalog_unreachable');
    expect(r.err).toContain(catalog);
    expect(r.err).not.toContain('internal_error');
    expect(existsSync(skills(p))).toBe(false);
    expect(existsSync(join(p.dir, 'project', '.claude'))).toBe(false);
  });

  it('install: a plain skill installs; one with a script is held and says to take it in the person\'s own terminal', async () => {
    const p = place();
    await seed(p);
    const plain = await cli(p, ['install', 'sql-migration-helper']);
    expect(plain.code).toBe(0);
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).toBe(skillMd('sql-migration-helper', 'Write and review SQL schema migrations.'));
    const held = await cli(p, ['install', 'release-notes-kit']);
    expect(held.code).toBe(3); // held: it waits for the person (review V4.1)
    expect(held.out).toContain('skills-catalog update release-notes-kit --accept');
    expect(existsSync(join(skills(p), 'release-notes-kit'))).toBe(false);
  });

  it('update <name> --accept shows the reasons and asks; yes takes it, no leaves it; the lock records the flags let through', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    const no = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['n'] });
    expect(no.code).toBe(0);
    expect(no.asked).toHaveLength(1);
    expect(no.out).toContain('scripts/collect.sh');
    expect(existsSync(join(skills(p), 'release-notes-kit'))).toBe(false);
    // The activity log shows the no, beside the yes it would have been.
    const last = readFileSync(join(p.home, 'activity.log'), 'utf8').trimEnd().split('\n').at(-1)!;
    expect(last.split(/\s{2,}/).slice(1)).toEqual(['-', 'update --accept', S.doc.log.result.accept_declined, 'release-notes-kit v2']);

    const yes = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    const dest = join(skills(p), 'release-notes-kit');
    expect(readFileSync(join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe('#!/bin/sh\necho collecting\n');
    expect(readLock(p.home).skills[dest]!.accepted).toEqual([{ version: 2, flags: ['runnable_file'] }]);
  });

  it('a person-only step with no terminal changes nothing, says what to run, and exits 3', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    const r = await cli(p, ['update', 'release-notes-kit', '--accept'], { tty: false, answers: ['y'] });
    expect(r.code).toBe(3);
    expect(r.asked).toEqual([]);
    expect(r.out + r.err).toContain(S.format(S.word('errors.person_only'), { command: 'skills-catalog update release-notes-kit --accept' }));
    expect(existsSync(join(skills(p), 'release-notes-kit'))).toBe(false);
    // The activity log shows it too, as waiting for the person, with the skill it was about.
    const last = readFileSync(join(p.home, 'activity.log'), 'utf8').trimEnd().split('\n').at(-1)!;
    expect(last.split(/\s{2,}/).slice(1)).toEqual(['-', 'update --accept', S.doc.log.error.person_only, 'release-notes-kit']);
  });

  it('a held project install is taken into the project: the command given carries --target project, and the intro names the folder', async () => {
    const p = place();
    await seed(p);
    const held = await cli(p, ['install', 'release-notes-kit', '--target', 'project']);
    expect(held.code).toBe(3); // held: it waits for the person (review V4.1)
    expect(held.out).toContain('skills-catalog update release-notes-kit --accept --target project');
    const dest = join(p.dir, 'project', '.claude', 'skills', 'release-notes-kit');
    const yes = await cli(p, ['update', 'release-notes-kit', '--accept', '--target', 'project'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain(dest);
    expect(readFileSync(join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe('#!/bin/sh\necho collecting\n');
    expect(existsSync(join(skills(p), 'release-notes-kit'))).toBe(false);
    // Without a terminal, the command given to the person keeps the target.
    const q = place();
    await seed(q);
    await cli(q, ['install', 'release-notes-kit', '--target', 'project']);
    const r = await cli(q, ['update', 'release-notes-kit', '--accept', '--target', 'project']);
    expect(r.code).toBe(3);
    expect(r.err).toContain(S.format(S.word('errors.person_only'), { command: 'skills-catalog update release-notes-kit --accept --target project' }));
  });

  // With a user copy installed too, the project's yes goes to the project, never over the user copy (a bug the B
  // validator found on V4.1's path: the accept took the first installed copy, whatever --target said).
  it('a held project install, with a user copy of the same skill: the yes installs into the project and leaves the user copy alone', async () => {
    const p = place();
    await seed(p);
    expect((await cli(p, ['install', 'release-notes-kit', '--version', '1'])).code).toBe(0);
    const user = join(skills(p), 'release-notes-kit');
    const before = readFileSync(join(user, 'SKILL.md'), 'utf8');
    expect((await cli(p, ['install', 'release-notes-kit', '--target', 'project'])).code).toBe(3);
    const yes = await cli(p, ['update', 'release-notes-kit', '--accept', '--target', 'project'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    const dest = join(p.dir, 'project', '.claude', 'skills', 'release-notes-kit');
    expect(readFileSync(join(dest, 'scripts', 'collect.sh'), 'utf8')).toBe('#!/bin/sh\necho collecting\n');
    expect(readFileSync(join(user, 'SKILL.md'), 'utf8')).toBe(before);
    expect(existsSync(join(user, 'scripts'))).toBe(false);
  });

  it('a "tell me first" skill: update names the command, and update <name> --accept shows it and takes it on a yes', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    writeFileSync(join(p.home, 'config.json'), JSON.stringify({ update_policy: 'notify' }));
    const c = await open(p);
    try {
      await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.', 'Second.\n') }]), actAs('ben'));
    } finally {
      c.close();
    }
    const at = { name: 'sql-migration-helper', from: 1, to: 2 };
    const u = await cli(p, ['update']);
    expect(u.out).toContain(S.format(S.word('update.held_notify'), at));
    expect(u.out).toContain(S.format(S.word('update.held_notify_next_cli'), at));
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).not.toContain('Second.');
    const yes = await cli(p, ['update', 'sql-migration-helper', '--accept'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain(S.format(S.word('update.accept_intro_notify'), at));
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).toContain('Second.');
  });

  // Why the hold waits picks the words: a pinned skill, or a copy from another catalog (contract §5.3's order).
  const second = async (p: Place) => {
    const c = await open(p);
    try {
      await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.', 'Second.\n') }]), actAs('ben'));
    } finally {
      c.close();
    }
  };
  const helper = (p: Place) => join(skills(p), 'sql-migration-helper');

  it('a pinned skill: update <name> --accept says it is pinned, and a yes takes the new version and keeps the pin', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    expect((await cli(p, ['policy', 'pin', 'sql-migration-helper'])).code).toBe(0);
    await second(p);
    const yes = await cli(p, ['update', 'sql-migration-helper', '--accept'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain(S.format(S.word('update.accept_intro_pin'), { name: 'sql-migration-helper', from: 1, to: 2, also: '' }));
    expect(readFileSync(join(helper(p), 'SKILL.md'), 'utf8')).toContain('Second.');
    expect(readLock(p.home).skills[helper(p)]).toMatchObject({ version: 2, policy: 'pin' });
  });

  it('a copy from another catalog: update <name> --accept says where each comes from, and a yes records the catalog in use', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    const now = readLock(p.home).skills[helper(p)]!.catalog;
    const was = join(p.dir, 'other-catalog');
    const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
    lock.skills[helper(p)].catalog = was;
    writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
    await second(p);
    const yes = await cli(p, ['update', 'sql-migration-helper', '--accept'], { tty: true, answers: ['y'] });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain(S.format(S.word('update.accept_intro_other_catalog'), { name: 'sql-migration-helper', from: 1, to: 2, was, now, also: '' }));
    expect(readLock(p.home).skills[helper(p)]).toMatchObject({ version: 2, catalog: now });
  });

  it('--target goes only with --accept, and only as user or project; --as in either form stays out of the command given', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'release-notes-kit']);
    for (const argv of [['update', '--target', 'project'], ['update', 'release-notes-kit', '--target', 'user'], ['update', 'release-notes-kit', '--accept', '--target', 'elsewhere']]) {
      const r = await cli(p, argv, { tty: true, answers: ['y'] });
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.asked, argv.join(' ')).toEqual([]);
    }
    expect(existsSync(join(skills(p), 'release-notes-kit'))).toBe(false);
    for (const as of [['--as=dev2'], ['--as', 'dev2']]) {
      const r = await cli(p, ['update', 'release-notes-kit', '--accept', ...as]);
      expect(r.code).toBe(3);
      expect(r.err).toContain(S.format(S.word('errors.person_only'), { command: 'skills-catalog update release-notes-kit --accept' }) + '\n');
    }
  });

  it('update and list on the command line: a text-only change updates, names limit it, the list shows it', async () => {
    const p = place();
    await seed(p);
    await cli(p, ['install', 'sql-migration-helper']);
    await cli(p, ['install', 'demo-skill-01']);
    const c = await open(p);
    try {
      await c.publish(request('sql-migration-helper', [{ path: 'SKILL.md', text: skillMd('sql-migration-helper', 'Write and review SQL schema migrations.', 'Second.\n') }]), actAs('ben'));
    } finally {
      c.close();
    }
    const one = await cli(p, ['update', 'demo-skill-01']);
    expect(one.out).toContain(S.format(S.word('update.header'), { checked: 1 }));
    const u = await cli(p, ['update']);
    expect(u.code).toBe(0);
    expect(u.out).toContain(S.format(S.word('update.updated'), { name: 'sql-migration-helper', from: 1, to: 2, changes: '"SKILL.md" changed' }));
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).toContain('Second.');
    const l = await cli(p, ['list']);
    expect(l.code).toBe(0);
    expect(l.out).toContain('sql-migration-helper');
    expect(l.out).toContain('demo-skill-01');
  });

  it('errors go to stderr with exit 1; "(Acting as …)" is last on results and errors alike', async () => {
    const p = place();
    await seed(p);
    const acting = S.format(S.word('acting_as'), { developer: 'dev2' });
    const ok = await cli(p, ['list', '--as', 'dev2']);
    expect(ok.code).toBe(0);
    expect(ok.out.trimEnd().split('\n').at(-1)).toBe(acting);
    const missing = await cli(p, ['install', 'no-such-skill', '--as', 'dev2']);
    expect(missing.code).toBe(1);
    expect(missing.out).toBe('');
    expect(missing.err).toContain('not_found');
    expect(missing.err.trimEnd().split('\n').at(-1)).toBe(acting);
    const badAs = await cli(p, ['list', '--as', 'dev 2']);
    expect(badAs.code).toBe(1);
    expect(badAs.err.trimEnd()).toBe(renderError(S, new CatalogError('invalid_request', { field: '--as', why: 'not_a_developer_name' })));
    const badNumber = await cli(p, ['install', 'release-notes-kit', '--version', 'two']);
    expect(badNumber.code).toBe(1);
    expect(badNumber.err).toContain('invalid_request');
  });

  it('the real command: results on stdout with exit 0, a person-only step with no terminal on stderr with exit 3', async () => {
    const p = place();
    await seed(p);
    const env = childEnv(p);
    const bin = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
    // As the installed command starts it: node:sqlite's experimental warning is off, so stderr carries only our words.
    const run = (args: string[]) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', bin, ...args], { env, cwd: p.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const ok = run(['install', 'sql-migration-helper']);
    expect([ok.status, ok.stderr]).toEqual([0, '']);
    expect(existsSync(join(p.osHome, '.claude', 'skills', 'sql-migration-helper', 'SKILL.md'))).toBe(true);
    const held = run(['update', 'release-notes-kit', '--accept']);
    expect(held.status).toBe(3);
    expect(held.stdout).toBe('');
    expect(held.stderr).toContain('skills-catalog update release-notes-kit --accept');
  });

  it('an unknown command or flag prints the usage and exits 1', async () => {
    const p = place();
    for (const argv of [['frobnicate'], ['list', '--no-such-flag']]) {
      const r = await cli(p, argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toContain('skills-catalog');
    }
  });

  it('asked for help (or nothing typed): what each command is for, on stdout, exit 0 (review V4.4)', async () => {
    const p = place();
    for (const argv of [[], ['help'], ['--help'], ['-h']]) {
      const r = await cli(p, argv);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.out).toContain('Find shared skills by what they do');
      expect(r.out).toContain('skills-catalog login');
      expect(r.out).not.toContain("didn't understand");
    }
  });
});
