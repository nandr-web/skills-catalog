// A run's last line: "nothing left behind" wherever the check lists processes (macOS with ps, Linux from /proc), and
// says what wasn't checked anywhere else.
import { describe, expect, it } from 'vitest';
import { statusLine } from '../src/status.ts';

const clean = { runId: '20260929T000000Z-0000abcd', status: 'pass' as const, differences: [] };

describe('a run\'s last line', () => {
  it('on macOS and on Linux, a clean run says nothing was left behind', () => {
    for (const platform of ['darwin', 'linux'] as const) expect(statusLine('run', clean, platform), platform).toBe('qa run 20260929T000000Z-0000abcd: pass, nothing left behind');
  });

  it('elsewhere, it says processes weren\'t checked', () => {
    expect(statusLine('run', clean, 'freebsd')).toBe('qa run 20260929T000000Z-0000abcd: pass; files, settings and ports unchanged; processes not checked on this system yet');
  });

  it('with differences, just the status', () => {
    expect(statusLine('demo', { ...clean, status: 'leak', differences: [{ key: 'k', what: 'x' }] }, 'linux')).toBe('qa demo 20260929T000000Z-0000abcd: leak');
  });
});
