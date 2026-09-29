// The activity log: one plain line per tool call, for the demo's bottom pane (SKILLS_ACTIVITY_LOG, else
// $SKILLS_HOME/activity.log). `HH:MM:SS  who  tool  result  target`, UTC, spaces only; the result is padded to the
// longest one, so a long target (skill names run to 64 characters) comes last and never shifts a column. It says who
// called which tool, how it ended and on which skills, never what was asked: the target comes from the result (skill
// names and versions, a match count), never from the arguments; no skill text, no paths, no secrets.
import { execFileSync } from 'node:child_process';
import { chmodSync, closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { actAs, Surface } from '@skills-catalog/core';
import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_WORD_GAPS } from '../src/operations.ts';
import { open, request, seed, skillMd } from './seed.ts';
import { place, startServer, type Place, type Server } from './server.ts';

const S = Surface.load();
const N = S.names as Record<'search' | 'get' | 'versions' | 'diff', string>;
const TIME = /^\d\d:\d\d:\d\d$/;

const servers: Server[] = [];
function start(p: Place, env: Record<string, string> = {}): Server {
  const s = startServer(p, env);
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const logOf = (p: Place, path = join(p.home, 'activity.log')) => readFileSync(path, 'utf8');
const linesOf = (p: Place, path?: string) => logOf(p, path).split('\n').filter(Boolean);
/** A line without its time, as the format lays it out. Until the log's words land, a result is its code: the longest is
 *  25 characters (invalid_developer_setting). */
const row = (who: string, tool: string, target: string, result: string) => `  ${who.padEnd(4)}  ${tool.padEnd(27)}  ${result.padEnd(25)}  ${target}`;

describe('the activity log', () => {
  it('one line per tool call: time, who, tool, the target from the result, how it ended; nothing for other messages', async () => {
    const p = place();
    await seed(p);
    const c = await open(p);
    const found = await c.search({ query: 'release notes' });
    c.close();
    const s = start(p, { SKILLS_AS: 'dev2' });
    await s.initialize();
    const t0 = new Date();
    await s.call(N.search, { query: 'release notes' });
    await s.call(N.get, { name: 'release-notes-kit' });
    await s.call(N.get, { names: ['release-notes-kit', 'relase-notes-kit', 'sql-migration-helper'] });
    await s.call(N.versions, { name: 'release-notes-kit' });
    await s.call(N.diff, { name: 'release-notes-kit', from: 1, to: 2 });
    await s.call(N.get, { name: 'relase-notes-kit' });
    await s.send('ping');
    await s.send('tools/list');
    await s.send('tools/call', { name: 'no_such_tool', arguments: {} });
    const lines = linesOf(p);
    expect(lines.map((l) => l.slice(8))).toEqual([
      row('dev2', N.search, `${found.total_matches}/${found.catalog_size}`, 'ok'),
      row('dev2', N.get, 'release-notes-kit v2', 'ok'),
      row('dev2', N.get, 'release-notes-kit v2, sql-migration-helper v1', 'ok'),
      row('dev2', N.versions, 'release-notes-kit v2', 'ok'),
      row('dev2', N.diff, 'release-notes-kit v1 → v2', 'ok'),
      row('dev2', N.get, '-', 'not_found'),
    ]);
    for (const l of lines) {
      expect(l.slice(0, 8)).toMatch(TIME);
      const [h, m, sec] = l.slice(0, 8).split(':').map(Number);
      const at = Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate(), h, m, sec);
      expect(Math.abs(at - t0.getTime())).toBeLessThan(60_000); // UTC, and now
    }
  });

  it('who is "-" with no acting developer, and with a name that isn\'t one (never the value itself)', async () => {
    const p = place();
    await seed(p);
    const a = start(p);
    await a.initialize();
    await a.call(N.search, { query: 'zzz-nothing' });
    const b = start(p, { SKILLS_AS: 'Dev Two\n00:00:00  admin  x  y  ok' });
    await b.initialize();
    await b.call(N.search, { query: 'release' });
    const lines = linesOf(p);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.slice(8)).toBe(row('-', N.search, '0/14', 'ok'));
    expect(lines[1]!.slice(8)).toBe(row('-', N.search, '-', 'invalid_developer_setting'));
    expect(logOf(p)).not.toContain('admin');
  });

  it('never holds arguments, skill text or paths, even a planted secret-shaped value', async () => {
    const marker = ['PLANTED', 'AKIA' + 'IOSFODNN7' + 'EXAMPLE'].join('-');
    const p = place();
    await seed(p, async (c) => {
      await c.publish(request('marker-skill', [{ path: 'SKILL.md', text: skillMd('marker-skill', 'Holds a planted value.', `The value: ${marker}\n`) }]), actAs('ana'));
    });
    const s = start(p, { SKILLS_AS: 'dev2' });
    await s.initialize();
    await s.call(N.search, { query: marker });
    await s.call(N.get, { name: 'marker-skill', include: 'contents' });
    await s.call(N.get, { name: marker });
    await s.call(N.get, { name: marker.toLowerCase() });
    await s.call(N.versions, { name: marker.toLowerCase() });
    await s.call(N.search, { query: 'x', cursor: marker });
    await s.call(N.search, { [marker]: 1 });
    await s.call(N.search, { query: 'value', filters: { tags: [marker], publisher: marker, updated_since: marker } });
    await s.call(N.get, { names: [marker.toLowerCase(), 'marker-skill', marker] });
    await s.call(N.diff, { name: marker.toLowerCase(), from: 1, to: 2 });
    await s.call(N.diff, { name: 'marker-skill', from: 1, to: 1 });
    const log = logOf(p);
    expect(linesOf(p)).toHaveLength(11);
    for (const needle of [marker, marker.toLowerCase(), 'PLANTED', 'planted', 'Holds', p.dir]) expect(log).not.toContain(needle);
  });

  it('is a 0600 file in a 0700 SKILLS_HOME that the server makes when it is missing', async () => {
    const p = place();
    await seed(p);
    expect(existsSync(p.home)).toBe(false);
    const s = start(p);
    await s.initialize();
    await s.call(N.search, { query: 'release' });
    expect(statSync(p.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(p.home, 'activity.log')).mode & 0o777).toBe(0o600);
  });

  it('a log file or SKILLS_HOME made looser before is tightened (0600, 0700)', async () => {
    const p = place();
    await seed(p);
    mkdirSync(p.home, { recursive: true });
    chmodSync(p.home, 0o755);
    writeFileSync(join(p.home, 'activity.log'), '');
    chmodSync(join(p.home, 'activity.log'), 0o644);
    const s = start(p);
    await s.initialize();
    await s.call(N.search, { query: 'release' });
    expect(statSync(p.home).mode & 0o777).toBe(0o700);
    expect(statSync(join(p.home, 'activity.log')).mode & 0o777).toBe(0o600);
  });

  it('a folder the person named with SKILLS_ACTIVITY_LOG is theirs: its mode is left as it is', async () => {
    const p = place();
    await seed(p);
    const theirs = join(p.dir, 'shared');
    mkdirSync(theirs);
    chmodSync(theirs, 0o755);
    const s = start(p, { SKILLS_ACTIVITY_LOG: join(theirs, 'activity.log') });
    await s.initialize();
    await s.call(N.search, { query: 'release' });
    expect(statSync(theirs).mode & 0o777).toBe(0o755);
    expect(linesOf(p, join(theirs, 'activity.log'))).toHaveLength(1);
  });

  it('a FIFO in the log\'s place never stalls the server, and nothing is written into it, even with a reader on it', async () => {
    const p = place();
    await seed(p);
    mkdirSync(p.home, { recursive: true, mode: 0o700 });
    const fifo = join(p.home, 'activity.log');
    execFileSync('mkfifo', [fifo]);
    const s = start(p);
    await s.initialize();
    const r = await s.call(N.search, { query: 'release' });            // no reader: opening it for writing would block
    expect(r.isError).toBeUndefined();
    const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      expect((await s.call(N.search, { query: 'release' })).isError).toBeUndefined();   // a reader: it opens, but isn't a file
      const got = (() => { try { return readSync(reader, Buffer.alloc(4096)); } catch { return 0; } })();
      expect(got).toBe(0);
    } finally {
      closeSync(reader);
    }
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  });

  it('SKILLS_ACTIVITY_LOG moves it (the demo points its pane there); its folder is made 0700', async () => {
    const p = place();
    await seed(p);
    const path = join(p.dir, 'demo', 'activity.log');
    const s = start(p, { SKILLS_ACTIVITY_LOG: path });
    await s.initialize();
    await s.call(N.search, { query: 'release' });
    expect(linesOf(p, path)).toHaveLength(1);
    expect(statSync(join(p.dir, 'demo')).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(join(p.home, 'activity.log'))).toBe(false);
  });

  it('a link at the log\'s place is never followed: its target stays as it was, and the tool still answers', async () => {
    const p = place();
    await seed(p);
    mkdirSync(p.home, { recursive: true, mode: 0o700 });
    const canary = join(p.dir, 'canary.txt');
    writeFileSync(canary, 'canary\n');
    symlinkSync(canary, join(p.home, 'activity.log'));
    const s = start(p);
    await s.initialize();
    const r = await s.call(N.search, { query: 'release' });
    expect(r.isError).toBeUndefined();
    expect(readFileSync(canary, 'utf8')).toBe('canary\n');
    expect(lstatSync(join(p.home, 'activity.log')).isSymbolicLink()).toBe(true);
  });

  it('two servers writing at once never tear a line', async () => {
    const p = place();
    await seed(p);
    const a = start(p, { SKILLS_AS: 'dev1' });
    const b = start(p, { SKILLS_AS: 'dev2' });
    await Promise.all([a.initialize(), b.initialize()]);
    await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).call(N.search, { query: 'release notes' })));
    const lines = linesOf(p);
    expect(lines).toHaveLength(40);
    for (const l of lines) expect(l.split(/ {2,}/)).toHaveLength(5);
    expect(lines.filter((l) => l.slice(8).startsWith('  dev1'))).toHaveLength(20);
  });

  it('a long target never moves a column: the result sits at the same place on every line', async () => {
    const long = 'a-skill-name-that-runs-long-like-the-sixty-four-character-limit';
    const p = place();
    await seed(p, async (c) => {
      for (const body of ['First.\n', 'Second.\n']) await c.publish(request(long, [{ path: 'SKILL.md', text: skillMd(long, 'A long name.', body) }]), actAs('ana'));
    });
    const s = start(p, { SKILLS_AS: 'dev2' });
    await s.initialize();
    await s.call(N.diff, { name: long, from: 1, to: 2 });
    await s.call(N.search, { query: 'release' });
    const lines = linesOf(p);
    expect(lines[0]!.slice(8)).toBe(row('dev2', N.diff, `${long} v1 → v2`, 'ok'));
    const at = (l: string) => l.indexOf('ok  ');
    expect(at(lines[0]!)).toBe(at(lines[1]!));
  });

  it('the log\'s words are still a gap in the surface (wire them when they land)', () => {
    expect(CLIENT_WORD_GAPS).toContain('log');
    expect(S.doc.log, 'the surface now has a log section: wire it and drop "log" from CLIENT_WORD_GAPS').toBeUndefined();
  });
});
