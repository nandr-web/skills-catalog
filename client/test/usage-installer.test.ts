// The installer's usage events (contract §3, usage metrics): a hold at every held install and every held line of an
// update, the person's yes where a held update is taken, a pin set on a skill whose update is waiting (an answer too),
// every policy change, and the mode at each sync (only its face until permissive modes are detected). Skill names are
// stored hashed.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Words, actAs } from '@skills-catalog/core';
import { describe, expect, it } from 'vitest';
import { contextFor, type Context } from '../src/operations.ts';
import { MACHINE_RUNS } from '../src/machine/index.ts';
import { readUsage, skillHash } from '../src/usage/record.ts';
import { settingsFrom } from '../src/settings.ts';
import { open, request, skillMd } from './seed.ts';
import { place, type Place } from './server.ts';

const S = Words.load();
const install = MACHINE_RUNS['install_shared_skill']!;
const update = MACHINE_RUNS['update_installed_skills']!;
const accept = MACHINE_RUNS['accept_held_update']!;
const policy = MACHINE_RUNS['set_skill_update_policy']!;

const ctxFor = (p: Place): Context => contextFor(settingsFrom({ SKILLS_HOME: p.home, SKILLS_CATALOG: p.catalogUrl, SKILLS_ASSISTANT_HOME: p.osHome, SKILLS_MANAGED_SETTINGS: p.managed }, join(p.dir, 'project')), S, 'mcp').ctx;
const events = (p: Place, kind: string) => readUsage(p.home).filter((e) => e.event === kind).map(({ v, at, ...e }) => e);
const heldOf = (text: string) => {
  const m = /target "([^"]+)", version (\d+), confirm "([^"]+)" and flags (\[[^\]]*\])/.exec(text);
  return m ? { target: m[1]!, version: Number(m[2]), confirm: m[3]!, flags: JSON.parse(m[4]!) as string[] } : undefined;
};

const plain = (name: string, body = 'Body.\n') => [{ path: 'SKILL.md', text: skillMd(name, `The ${name} skill.`, body) }];
const script = (name: string) => [...plain(name, 'With a script.\n'), { path: 'run.sh', text: '#!/bin/sh\n', mode: '0755' }];
async function publish(p: Place, name: string, files: { path: string; text: string; mode?: string }[]): Promise<void> {
  const c = await open(p);
  try {
    await c.publish(request(name, files), actAs('ana'));
  } finally {
    c.close();
  }
}

describe('the installer records its holds, the person\'s yes and pins, policy changes and syncs', () => {
  it('a held first install is one hold (nothing behind); taking it is one yes', async () => {
    const p = place();
    const ctx = ctxFor(p);
    await publish(p, 'runner', script('runner'));
    const held = heldOf((await install(ctx, { name: 'runner' })).text)!;
    const skill = skillHash(p.home, 'runner');
    expect(events(p, 'hold')).toEqual([{ event: 'hold', skill, version: 1, reason: 'flagged', flags: ['runnable_file'], behind: 0 }]);
    await accept(ctx, { name: 'runner', ...held });
    expect(events(p, 'answer')).toEqual([{ event: 'answer', skill, version: 1, answer: 'yes', together: 1 }]);
  });

  it('each held line of an update is a hold, with why and how many versions behind; a sync is a mode event', async () => {
    const p = place();
    const ctx = ctxFor(p);
    for (const name of ['flagged', 'pinned', 'asked', 'elsewhere', 'plain']) await publish(p, name, plain(name));
    for (const name of ['flagged', 'pinned', 'asked', 'elsewhere', 'plain']) await install(ctx, { name });
    await policy(ctx, { name: 'pinned', policy: 'pin' });
    await policy(ctx, { name: 'asked', policy: 'notify' });
    const lock = JSON.parse(readFileSync(join(p.home, 'lock.json'), 'utf8'));
    lock.skills[join(p.osHome, '.claude', 'skills', 'elsewhere')].catalog = join(p.dir, 'other-catalog');
    writeFileSync(join(p.home, 'lock.json'), JSON.stringify(lock, null, 2) + '\n');
    await publish(p, 'flagged', script('flagged'));
    await publish(p, 'flagged', [...script('flagged'), { path: 'more.md', text: 'More.\n' }]);
    for (const name of ['pinned', 'asked', 'elsewhere', 'plain']) await publish(p, name, plain(name, 'Second.\n'));
    await update(ctx, {});
    const h = (name: string) => skillHash(p.home, name);
    expect(events(p, 'hold')).toEqual([
      { event: 'hold', skill: h('asked'), version: 2, reason: 'notify', flags: [], behind: 1 },
      { event: 'hold', skill: h('elsewhere'), version: 2, reason: 'other_catalog', flags: [], behind: 1 },
      { event: 'hold', skill: h('flagged'), version: 3, reason: 'flagged', flags: ['runnable_file'], behind: 2 },
      { event: 'hold', skill: h('pinned'), version: 2, reason: 'pin', flags: [], behind: 1 },
    ]);
    expect(events(p, 'mode')).toEqual([{ event: 'mode', mode: 'default', face: 'update' }]);
  });

  it('each sync records the permissive mode Claude Code\'s settings turn on, unknown when a settings file can\'t be used', async () => {
    const cases: [string, string, Record<string, unknown>][] = [
      ['.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'auto' } }), { mode: 'auto' }],
      ['.claude/settings.json', JSON.stringify({ permissions: { allow: ['Bash(python3 *)'] } }), { mode: 'broad_bash_rule' }],
      ['.claude/settings.json', '{"permissions": ', { mode: 'unknown' }],
      ['.claude/settings.json', JSON.stringify({ permissions: { defaultMode: 'acceptEdits' } }), { mode: 'default' }],
    ];
    for (const [file, text, mode] of cases) {
      const p = place();
      const ctx = ctxFor(p);
      await publish(p, 'plain', plain('plain'));
      await install(ctx, { name: 'plain' });
      mkdirSync(join(p.osHome, '.claude'), { recursive: true });
      writeFileSync(join(p.osHome, file), text);
      await update(ctx, {});
      expect([text, events(p, 'mode')]).toEqual([text, [{ event: 'mode', ...mode, face: 'update' }]]);
    }
  });

  it('an install over a pinned copy is a hold; a pin set while an update waits is the person\'s answer, and a policy change', async () => {
    const p = place();
    const ctx = ctxFor(p);
    await publish(p, 'kept', plain('kept'));
    await install(ctx, { name: 'kept' });
    await publish(p, 'kept', plain('kept', 'Second.\n'));
    await policy(ctx, { name: 'kept', policy: 'notify' });
    await install(ctx, { name: 'kept' });
    const skill = skillHash(p.home, 'kept');
    expect(events(p, 'hold')).toEqual([{ event: 'hold', skill, version: 2, reason: 'notify', flags: [], behind: 1 }]);
    await policy(ctx, { name: 'kept', policy: 'pin' });
    expect(events(p, 'answer')).toEqual([{ event: 'answer', skill, version: 2, answer: 'pin', together: 1 }]);
    await policy(ctx, { policy: 'pin' });
    expect(events(p, 'policy')).toEqual([
      { event: 'policy', from: 'auto', to: 'notify', scope: 'skill', near_hold: false },
      { event: 'policy', from: 'notify', to: 'pin', scope: 'skill', near_hold: true },
      { event: 'policy', from: 'auto', to: 'pin', scope: 'catalog', near_hold: true },
    ]);
    // A catalog-wide pin answers nothing.
    expect(events(p, 'answer')).toHaveLength(1);
  });
});
