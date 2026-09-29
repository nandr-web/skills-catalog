// The CLI face (contract §1, §3): the API's operations as commands, named as the words file's CLI names them. Skill
// names are positional; every other input is --field-name (a list one comma-separated value). Results go to stdout and
// errors to stderr, with "(Acting as …)" last on both while a developer is set; exit 0 done, 1 an error, 3 needs the
// person. The person-only step (update <name> --accept) asks in the person's own terminal and refuses without one.
// Each command's own behaviour: cli-commands.test.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actAs, renderError, CatalogError } from '@skills-catalog/core';
import { refuseRealPlaces } from '@skills-catalog/core/testing';
import { describe, expect, it } from 'vitest';
import { readLock } from '../src/machine/lock.ts';
import { cli, S } from './cli-io.ts';
import { open, request, seed, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

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

  it('serves the catalog\'s and the installer\'s commands, the MCP server and the local page; preview, publish and setup are still to come', async () => {
    const p = place();
    const u = await cli(p, ['frobnicate']);
    expect(u.err.split('\n').filter((l) => l.startsWith('  ')).map((l) => l.trim().split(' ')[1])).toEqual(['search', 'read', 'versions', 'diff', 'install', 'update', 'list', 'policy', 'update', 'stats', 'mcp', 'serve']);
    for (const word of ['preview', 'publish', 'setup']) {
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

  it('install: a plain skill installs; one with a script is held and says to take it in the person\'s own terminal', async () => {
    const p = place();
    await seed(p);
    const plain = await cli(p, ['install', 'sql-migration-helper']);
    expect(plain.code).toBe(0);
    expect(readFileSync(join(skills(p), 'sql-migration-helper', 'SKILL.md'), 'utf8')).toBe(skillMd('sql-migration-helper', 'Write and review SQL schema migrations.'));
    const held = await cli(p, ['install', 'release-notes-kit']);
    expect(held.code).toBe(0);
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
    expect(held.code).toBe(0);
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
    const env = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: p.osHome, SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl };
    for (const v of [env.HOME, env.SKILLS_HOME]) refuseRealPlaces(v);
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
    for (const argv of [['frobnicate'], ['list', '--no-such-flag'], []]) {
      const r = await cli(p, argv);
      expect(r.code, argv.join(' ')).toBe(1);
      expect(r.err).toContain('skills-catalog');
    }
  });
});
