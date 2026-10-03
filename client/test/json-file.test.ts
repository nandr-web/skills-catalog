// Reading a JSON file of the person's (setup build notes §1): the first fault wins, in order: absent; a link; anything but
// a regular file; for a file setup would write, another user's or one with more than one hard link; a file swapped between
// the look and the open (read again once); one byte over the cap; anything but strict UTF-8 JSON with an object at the top.
// A usable file comes with the snapshot the write checks against.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { readJsonFile } from '../src/machine/json-file.ts';
import { race } from './race-fs.ts';
import { clearHooks } from './race.ts';
import { place } from './server.ts';

vi.mock('node:fs', async (o) => (await import('./race-fs.ts')).mockFs(await o()));
afterEach(clearHooks);

const dir = () => {
  const d = join(place().dir, 'files');
  race.fs.mkdirSync(d, { recursive: true });
  return d;
};
const file = (text: string | Buffer, name = 'settings.json') => {
  const path = join(dir(), name);
  race.fs.writeFileSync(path, text, { mode: 0o600 });
  return path;
};
const whyOf = (r: ReturnType<typeof readJsonFile>) => ('why' in r ? r.why : 'absent' in r ? 'absent' : 'ok');

describe('reading a JSON file of the person\'s', () => {
  it('a usable file: its value and the snapshot a write is checked against', () => {
    const text = '{\n  "a": 1.0\n}\n';
    const path = file(text);
    const r = readJsonFile(path, 1024, { forWrite: true });
    if (!('snapshot' in r)) throw new Error(whyOf(r));
    const st = race.fs.lstatSync(path, { bigint: true });
    expect(r.value).toEqual({ a: 1 });
    expect(r.text).toBe(text);
    expect(r.snapshot).toEqual({ dev: st.dev, ino: st.ino, size: st.size, mtimeNs: st.mtimeNs, mode: st.mode, uid: st.uid, gid: st.gid, sha256: createHash('sha256').update(text).digest('hex') });
  });

  it('absent is absent (setup may make it)', () => {
    expect(readJsonFile(join(dir(), 'none.json'), 1024, { forWrite: true })).toEqual({ absent: true });
  });

  it('refuses in order, the first fault winning', () => {
    const d = dir();
    const target = file('{}', 'target.json');
    race.fs.symlinkSync(target, join(d, 'link.json'));
    race.fs.mkdirSync(join(d, 'folder.json'));
    const twice = file('{}', 'twice.json');
    race.fs.linkSync(twice, join(d, 'twice-2.json'));
    const cases: [string, string, boolean][] = [
      [join(d, 'link.json'), 'link', false],
      [join(d, 'folder.json'), 'unreadable', false],
      [twice, 'hard_linked', true],
      [file('{"a": "' + 'x'.repeat(100) + '"}', 'big.json'), 'too_big', false],
      [file('﻿{}', 'bom.json'), 'not_json', false],
      [file(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]), 'bytes.json'), 'not_json', false],
      [file('{"a": 1,}', 'comma.json'), 'not_json', false],
      [file('[]', 'list.json'), 'not_json', false],
    ];
    for (const [path, why, forWrite] of cases) expect([path, whyOf(readJsonFile(path, 64, { forWrite }))]).toEqual([path, why]);
    // Reading only (the permissive check), a second hard link doesn't matter.
    expect(whyOf(readJsonFile(twice, 64, { forWrite: false }))).toBe('ok');
  });

  it('a file of another user is refused for writing, and read as it is otherwise', () => {
    const path = file('{}');
    race.stats = (p) => (p === path ? { uid: (process.getuid?.() ?? 0) + 1 } : undefined);
    expect(whyOf(readJsonFile(path, 64, { forWrite: true }))).toBe('other_user');
    expect(whyOf(readJsonFile(path, 64, { forWrite: false }))).toBe('ok');
  });

  it('one byte over the cap is too big; the cap itself is fine', () => {
    const text = `{"a": "${'x'.repeat(10)}"}`;
    expect(whyOf(readJsonFile(file(text), text.length, { forWrite: true }))).toBe('ok');
    expect(whyOf(readJsonFile(file(text), text.length - 1, { forWrite: true }))).toBe('too_big');
  });

  it('a file swapped between the look and the open is read again once; swapped each time, it\'s unreadable', () => {
    const path = file('{"a": 1}');
    let swaps = 0;
    const swap = () => {
      swaps++;
      race.fs.rmSync(path);
      race.fs.writeFileSync(path, '{"a": 2}', { mode: 0o600 });
    };
    // Right after the look (the stat the look returns passes through here), before the open.
    race.stats = (p) => {
      if (p === path && swaps === 0) swap();
      return undefined;
    };
    const again = readJsonFile(path, 64, { forWrite: true });
    expect('value' in again && again.value).toEqual({ a: 2 });
    race.stats = (p) => {
      if (p === path) swap();
      return undefined;
    };
    expect(whyOf(readJsonFile(path, 64, { forWrite: true }))).toBe('unreadable');
  });

  it('every open of the file is no-follow and non-blocking, so a fifo put there never hangs the read', () => {
    const path = file('{}');
    const flags: number[] = [];
    race.onOpen = (p, f) => {
      if (p === path) flags.push(Number(f));
    };
    readJsonFile(path, 64, { forWrite: true });
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) expect([f & constants.O_NOFOLLOW, f & constants.O_NONBLOCK]).toEqual([constants.O_NOFOLLOW, constants.O_NONBLOCK]);
  });

  it('a fifo swapped in right after the look is unreadable at once, never waited on', () => {
    const path = file('{"a": 1}');
    const top = join(path, '..');
    // Children get their own environment, every home-like place in the test's folder.
    const env = { PATH: '/usr/bin:/bin', HOME: top, XDG_CONFIG_HOME: top, XDG_DATA_HOME: top, CLAUDE_CONFIG_DIR: top, TMPDIR: top };
    // A writer opens the fifo after 2 s: a read that blocked on the open would end then, too late for the check below,
    // instead of hanging the run.
    let writer: ReturnType<typeof spawn> | undefined;
    onTestFinished(() => void writer?.kill('SIGKILL'));
    race.stats = (p) => {
      if (p !== path || writer) return undefined;
      race.fs.rmSync(path);
      execFileSync('/usr/bin/mkfifo', [path], { env });
      writer = spawn('/bin/sh', ['-c', 'sleep 2; : > "$1"', 'sh', path], { env, stdio: 'ignore' });
      return undefined;
    };
    const started = performance.now();
    const r = readJsonFile(path, 64, { forWrite: true });
    expect([whyOf(r), performance.now() - started < 1000]).toEqual(['unreadable', true]);
  });

  it('what was opened must be a regular file, even when the look said it was one', () => {
    const d = dir();
    const path = join(d, 'settings.json');
    const env = { PATH: '/usr/bin:/bin', HOME: d, XDG_CONFIG_HOME: d, XDG_DATA_HOME: d, CLAUDE_CONFIG_DIR: d, TMPDIR: d };
    execFileSync('/usr/bin/mkfifo', [path], { env });
    race.stats = (p) => (p === path ? ({ mode: 0o100600, nlink: 1 } as never) : undefined);
    expect(whyOf(readJsonFile(path, 64, { forWrite: true }))).toBe('unreadable');
  });

  it('what a refusal says is only why: nothing of the file is in it', () => {
    const SENTINEL = 'PLANTED-SENTINEL-7f3a';
    // The last one is JSON the parser's own message quotes from.
    const texts = [`{"a": "${SENTINEL}",}`, `{"a": "${SENTINEL}${'x'.repeat(100)}"}`, `["${SENTINEL}"]`, `﻿{"a": "${SENTINEL}"}`, `{"a": ${SENTINEL}}`];
    for (const text of texts) {
      const r = readJsonFile(file(text), 64, { forWrite: true });
      expect('why' in r).toBe(true);
      expect(JSON.stringify(r)).not.toContain(SENTINEL);
    }
  });
});
