// Usage metrics, the recorder (contract §3): events as JSON lines in $SKILLS_HOME/usage/, one file per
// UTC day, kept 90 days and never sent anywhere. A skill's name is stored only as a keyed hash made with a secret this
// machine keeps, and each event keeps only its own fields, so nothing a person or a publisher typed is ever written.
// Recording never fails or slows what it records.
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sandbox } from '@skills-catalog/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdWithinADay, readUsage, recordUsage, USAGE_DAYS, USAGE_READ_MAX_BYTES } from '../src/usage/record.ts';

const day = (iso: string) => new Date(`${iso}T12:00:00Z`);
const home = () => join(sandbox(), 'skills-home');
const lines = (h: string, date: string) => readFileSync(join(h, 'usage', `${date}.jsonl`), 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));

describe('recording usage', () => {
  it('writes one line per event to that UTC day\'s file, only the client can read it', () => {
    const h = home();
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 2 }, new Date('2026-09-29T23:59:59Z'));
    recordUsage(h, { event: 'policy', from: 'auto', to: 'notify', scope: 'catalog', near_hold: false }, new Date('2026-09-30T00:00:01Z'));
    expect(lines(h, '2026-09-29')).toEqual([{ v: 1, at: '2026-09-29T23:59:59.000Z', event: 'notice', surface: 'hook', waiting: 2 }]);
    expect(lines(h, '2026-09-30')).toEqual([{ v: 1, at: '2026-09-30T00:00:01.000Z', event: 'policy', from: 'auto', to: 'notify', scope: 'catalog', near_hold: false }]);
    expect(statSync(join(h, 'usage')).mode & 0o777).toBe(0o700);
    expect(statSync(join(h, 'usage', '2026-09-29.jsonl')).mode & 0o777).toBe(0o600);
  });

  // The field an event is seen from was called surface before the API's names (the words file, faces); a person's kept
  // lines from before still count.
  it('writes the face an event came from; a line kept from before, with surface, reads as face', () => {
    const h = home();
    mkdirSync(join(h, 'usage'), { recursive: true, mode: 0o700 });
    const before = [
      { v: 1, at: '2026-09-29T10:00:00.000Z', event: 'notice', surface: 'hook', waiting: 1 },
      { v: 1, at: '2026-09-29T10:00:01.000Z', event: 'mode', surface: 'update' },
      { v: 1, at: '2026-09-29T10:00:02.000Z', event: 'look', skill: 'AAAAAAAAAAAAAAAA', version: 2, surface: 'cli' },
      { v: 1, at: '2026-09-29T10:00:03.000Z', event: 'notice', surface: 'mcp', face: 'hook', waiting: 1 },
    ];
    writeFileSync(join(h, 'usage', '2026-09-29.jsonl'), before.map((l) => JSON.stringify(l) + '\n').join(''), { mode: 0o600 });
    recordUsage(h, { event: 'notice', face: 'mcp', waiting: 2 }, new Date('2026-09-29T11:00:00Z'));
    expect(lines(h, '2026-09-29').at(-1)).toEqual({ v: 1, at: '2026-09-29T11:00:00.000Z', event: 'notice', face: 'mcp', waiting: 2 });
    expect(readUsage(h, new Date('2026-09-29T12:00:00Z'))).toEqual([
      { v: 1, at: '2026-09-29T10:00:00.000Z', event: 'notice', face: 'hook', waiting: 1 },
      { v: 1, at: '2026-09-29T10:00:01.000Z', event: 'mode', face: 'update' },
      { v: 1, at: '2026-09-29T10:00:02.000Z', event: 'look', skill: 'AAAAAAAAAAAAAAAA', version: 2, face: 'cli' },
      // a line with both says face; surface is only read where face is missing
      { v: 1, at: '2026-09-29T10:00:03.000Z', event: 'notice', face: 'hook', waiting: 1 },
      { v: 1, at: '2026-09-29T11:00:00.000Z', event: 'notice', face: 'mcp', waiting: 2 },
    ]);
  });

  it('stores a skill\'s name only as a keyed hash: the same on this machine, different on another, never the name', () => {
    const h = home();
    const at = day('2026-09-29');
    recordUsage(h, { event: 'hold', skill: 'release-notes-kit', version: 2, reason: 'flagged', flags: ['runnable_file'], behind: 1 }, at, { createKey: true });
    recordUsage(h, { event: 'look', skill: 'release-notes-kit', version: 2, surface: 'cli' }, at);
    recordUsage(h, { event: 'look', skill: 'sql-migration-helper', version: 3, surface: 'assistant' }, at);
    const [hold, look, other] = lines(h, '2026-09-29');
    expect(hold.skill).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(look.skill).toBe(hold.skill);
    expect(other.skill).not.toBe(hold.skill);
    expect(readFileSync(join(h, 'usage', '2026-09-29.jsonl'), 'utf8')).not.toMatch(/release|notes|sql|migration/);
    const elsewhere = home();
    recordUsage(elsewhere, { event: 'look', skill: 'release-notes-kit', version: 2, surface: 'cli' }, at, { createKey: true });
    expect(lines(elsewhere, '2026-09-29')[0].skill).not.toBe(hold.skill);
  });

  it('keeps only each event\'s own fields, so no text can ride along', () => {
    const h = home();
    const sneaky = { event: 'notice', surface: 'mcp', waiting: 1, query: 'my secret project', text: 'x' } as unknown as Parameters<typeof recordUsage>[1];
    recordUsage(h, sneaky, day('2026-09-29'));
    recordUsage(h, { event: 'answer', skill: 'a', version: 1, answer: 'maybe' as 'yes', together: 1 }, day('2026-09-29'));
    recordUsage(h, { event: 'frobnicate' } as unknown as Parameters<typeof recordUsage>[1], day('2026-09-29'));
    expect(lines(h, '2026-09-29')).toEqual([{ v: 1, at: '2026-09-29T12:00:00.000Z', event: 'notice', surface: 'mcp', waiting: 1 }]);
  });

  it('use: one per operation, its code only; mode: the sync\'s surface, its mode once detection is built', () => {
    const h = home();
    const at = day('2026-09-29');
    recordUsage(h, { event: 'use', op: 'search_shared_skills', result: 'none' }, at);
    recordUsage(h, { event: 'use', op: 'install_shared_skill', result: 'exists_untracked' }, at);
    recordUsage(h, { event: 'use', op: 'no_such_operation', result: 'ok' }, at);
    recordUsage(h, { event: 'use', op: 'read_shared_skill', result: 'release notes for acme' }, at);
    recordUsage(h, { event: 'mode', surface: 'hook' }, at);
    recordUsage(h, { event: 'mode', surface: 'update', mode: 'bypass' }, at);
    recordUsage(h, { event: 'mode', surface: 'hook', mode: 'sometimes' as 'auto' }, at);
    expect(lines(h, '2026-09-29').map(({ v, at: _, ...e }) => e)).toEqual([
      { event: 'use', op: 'search_shared_skills', result: 'none' },
      { event: 'use', op: 'install_shared_skill', result: 'exists_untracked' },
      { event: 'mode', surface: 'hook' },
      { event: 'mode', surface: 'update', mode: 'bypass' },
    ]);
  });

  it(`keeps ${USAGE_DAYS} days: the day ${USAGE_DAYS} days back is kept and read, the day before it goes; nothing else in the folder is touched`, () => {
    const h = home();
    // 2026-09-29 less 90 days is 2026-07-01.
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-06-30'));
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 2 }, new Date('2026-07-01T00:00:00Z'));
    writeFileSync(join(h, 'usage', 'notes.txt'), 'the person\'s own file\n');
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 3 }, day('2026-09-29'));
    expect(readdirSync(join(h, 'usage')).sort()).toEqual(['2026-07-01.jsonl', '2026-09-29.jsonl', 'notes.txt']);
    expect(readUsage(h, day('2026-09-29')).map((e) => (e.event === 'notice' ? e.waiting : 0))).toEqual([2, 3]);
    expect(readUsage(h, day('2026-09-30')).map((e) => (e.event === 'notice' ? e.waiting : 0))).toEqual([3]);
  });

  it('the old days still go when today\'s line can\'t be written (a pipe in its place): only the day files, never the pipe', () => {
    const h = home();
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-06-30'));
    const today = join(h, 'usage', '2026-09-29.jsonl');
    execFileSync('mkfifo', [today]);
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 2 }, day('2026-09-29'));
    expect(readdirSync(join(h, 'usage'))).toEqual(['2026-09-29.jsonl']);
    expect(lstatSync(today).isFIFO()).toBe(true);
  });

  it('tightens its own folder to 0700 and a day file to 0600 when they were looser', () => {
    const h = home();
    mkdirSync(join(h, 'usage'), { recursive: true, mode: 0o755 });
    chmodSync(join(h, 'usage'), 0o755);
    writeFileSync(join(h, 'usage', '2026-09-29.jsonl'), '', { mode: 0o644 });
    chmodSync(join(h, 'usage', '2026-09-29.jsonl'), 0o644);
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'));
    expect(statSync(join(h, 'usage')).mode & 0o777).toBe(0o700);
    expect(statSync(join(h, 'usage', '2026-09-29.jsonl')).mode & 0o777).toBe(0o600);
    expect(lines(h, '2026-09-29')).toHaveLength(1);
  });

  it('a hold may be for a skill from another catalog', () => {
    const h = home();
    recordUsage(h, { event: 'hold', skill: 'a', version: 1, reason: 'other_catalog', flags: [], behind: 0 }, day('2026-09-29'), { createKey: true });
    expect(lines(h, '2026-09-29')[0]).toMatchObject({ event: 'hold', reason: 'other_catalog' });
  });

  it('never follows a link in its folder\'s place, and never fails what it records', () => {
    const h = home();
    const outside = join(sandbox(), 'outside');
    mkdirSync(outside);
    mkdirSync(h, { recursive: true });
    symlinkSync(outside, join(h, 'usage'));
    expect(() => recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'))).not.toThrow();
    expect(readdirSync(outside)).toEqual([]);
    const file = join(sandbox(), 'a-file');
    writeFileSync(file, '');
    expect(() => recordUsage(file, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'))).not.toThrow();
    const locked = home();
    mkdirSync(join(locked, 'usage'), { recursive: true });
    chmodSync(join(locked, 'usage'), 0o500);
    expect(() => recordUsage(locked, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'))).not.toThrow();
    chmodSync(join(locked, 'usage'), 0o700);
  });
});

describe('the machine secret a skill\'s hash is keyed with', () => {
  const key = (h: string) => join(h, 'confirm.key');

  it('a read (a look from a diff) never creates it: without it, an event naming a skill is dropped; one naming none is kept', () => {
    const h = home();
    recordUsage(h, { event: 'look', skill: 'a', version: 2, surface: 'cli' }, day('2026-09-29'));
    recordUsage(h, { event: 'use', op: 'search_shared_skills', result: 'none' }, day('2026-09-29'));
    expect(existsSync(key(h))).toBe(false);
    expect(lines(h, '2026-09-29').map((e) => e.event)).toEqual(['use']);
  });

  it('what writes anyway (a hold, an answer) may make it; after that a read\'s event is kept', () => {
    const h = home();
    recordUsage(h, { event: 'hold', skill: 'a', version: 2, reason: 'flagged', flags: [], behind: 1 }, day('2026-09-29'), { createKey: true });
    expect(statSync(key(h)).mode & 0o777).toBe(0o600);
    recordUsage(h, { event: 'look', skill: 'a', version: 2, surface: 'cli' }, day('2026-09-29'));
    expect(lines(h, '2026-09-29').map((e) => e.event)).toEqual(['hold', 'look']);
  });

  it('a key that isn\'t safe (a wider mode) is never used or replaced by a read', () => {
    const h = home();
    recordUsage(h, { event: 'hold', skill: 'a', version: 2, reason: 'flagged', flags: [], behind: 1 }, day('2026-09-29'), { createKey: true });
    chmodSync(key(h), 0o644);
    const before = readFileSync(key(h));
    recordUsage(h, { event: 'look', skill: 'a', version: 2, surface: 'cli' }, day('2026-09-29'));
    expect(readFileSync(key(h))).toEqual(before);
    expect(statSync(key(h)).mode & 0o777).toBe(0o644);
    expect(lines(h, '2026-09-29').map((e) => e.event)).toEqual(['hold']);
  });
});

describe('a day file hard-linked to a file elsewhere', () => {
  it('is neither written, tightened nor read', () => {
    const h = home();
    mkdirSync(join(h, 'usage'), { recursive: true });
    const outside = join(sandbox(), 'outside.jsonl');
    writeFileSync(outside, JSON.stringify({ v: 1, at: '2026-09-29T01:00:00.000Z', event: 'notice', surface: 'mcp', waiting: 9 }) + '\n', { mode: 0o644 });
    chmodSync(outside, 0o644);
    linkSync(outside, join(h, 'usage', '2026-09-29.jsonl'));
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'));
    expect(readFileSync(outside, 'utf8').trimEnd().split('\n')).toHaveLength(1);
    expect(statSync(outside).mode & 0o777).toBe(0o644);
    expect(readUsage(h, day('2026-09-29'))).toEqual([]);
  });
});

describe('files another user owns', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });
  // The recorder reads this user's id once, when it loads: a fresh copy of it loaded after the stand-in sees what's on
  // disk as someone else's.
  const asAnotherUser = async () => {
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid!() + 1);
    vi.resetModules();
    return import('../src/usage/record.ts');
  };

  it('a usage folder or day file another user owns is neither written, tightened nor read', async () => {
    const h = home();
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'));
    chmodSync(join(h, 'usage'), 0o755);
    const other = await asAnotherUser();
    other.recordUsage(h, { event: 'notice', surface: 'hook', waiting: 2 }, day('2026-09-29'));
    expect(lines(h, '2026-09-29').map((e) => e.waiting)).toEqual([1]);
    expect(statSync(join(h, 'usage')).mode & 0o777).toBe(0o755);
    expect(other.readUsage(h, day('2026-09-29'))).toEqual([]);
    expect(readUsage(h, day('2026-09-29'))).toHaveLength(1);   // this user's own copy still reads it
  });
});

describe('a hold in the last day (a policy change\'s near_hold)', () => {
  it('is true only when a hold was recorded within the last 24 hours', () => {
    const h = home();
    const now = new Date('2026-09-29T12:00:00Z');
    expect(holdWithinADay(h, now)).toBe(false);
    recordUsage(h, { event: 'hold', skill: 'a', version: 2, reason: 'flagged', flags: [], behind: 1 }, new Date('2026-09-28T11:59:00Z'), { createKey: true });
    recordUsage(h, { event: 'look', skill: 'a', version: 2, surface: 'cli' }, new Date('2026-09-29T11:00:00Z'));
    expect(holdWithinADay(h, now)).toBe(false);
    recordUsage(h, { event: 'hold', skill: 'a', version: 2, reason: 'notify', flags: [], behind: 1 }, new Date('2026-09-28T12:01:00Z'), { createKey: true });
    expect(holdWithinADay(h, now)).toBe(true);
  });
});

describe('reading usage back', () => {
  it('reads the kept days in time order, skipping lines it can\'t read', () => {
    const h = home();
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'));
    recordUsage(h, { event: 'notice', surface: 'mcp', waiting: 3 }, day('2026-09-28'));
    writeFileSync(join(h, 'usage', '2026-09-28.jsonl'), 'not json\n{"v":9,"event":"notice"}\n', { flag: 'a' });
    const events = readUsage(h, day('2026-09-29'));
    expect(events.map((e) => [e.at, e.event, e.event === 'notice' ? e.waiting : null])).toEqual([
      ['2026-09-28T12:00:00.000Z', 'notice', 3],
      ['2026-09-29T12:00:00.000Z', 'notice', 1],
    ]);
  });

  it('reads only plain day files of a sane size: a link, a pipe or an oversized file is skipped, never waited on', () => {
    const h = home();
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-09-29'));
    const elsewhere = join(sandbox(), 'elsewhere.jsonl');
    writeFileSync(elsewhere, JSON.stringify({ v: 1, at: '2026-09-28T12:00:00.000Z', event: 'notice', surface: 'mcp', waiting: 9 }) + '\n');
    symlinkSync(elsewhere, join(h, 'usage', '2026-09-28.jsonl'));
    execFileSync('mkfifo', [join(h, 'usage', '2026-09-27.jsonl')]);
    writeFileSync(join(h, 'usage', '2026-09-26.jsonl'), Buffer.alloc(USAGE_READ_MAX_BYTES + 1, 0x20));
    expect(readUsage(h, day('2026-09-29')).map((e) => (e.event === 'notice' ? e.waiting : 0))).toEqual([1]);
  });

  it('reads nothing past the kept days, and nothing when there is no folder', () => {
    const h = home();
    expect(readUsage(h, day('2026-09-29'))).toEqual([]);
    recordUsage(h, { event: 'notice', surface: 'hook', waiting: 1 }, day('2026-06-01'));
    expect(existsSync(join(h, 'usage', '2026-06-01.jsonl'))).toBe(true);
    expect(readUsage(h, day('2026-09-29'))).toEqual([]);
  });
});
