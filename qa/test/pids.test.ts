// A process id read from text (a tool's output, a file) is signalled only when it's a whole number above 0: an empty
// line reads as 0 with Number(), and a signal to 0 reaches the sender's own process group (vitest's, and without job
// control whatever started the tests); -1 reaches every process the sender may signal.
import { describe, expect, it } from 'vitest';
import { firstPid, pidFrom } from '../src/pids.ts';

describe('a process id read from text', () => {
  it('is a whole number above 0, with the spaces and line end around it ignored', () => {
    expect(pidFrom(' 4242\n')).toBe(4242);
    expect(pidFrom('1')).toBe(1);
  });

  it('empty, 0, negative, not a whole number, or not a number at all: none', () => {
    for (const bad of ['', '\n', '0', '00', '-1', '-4242', '1.5', '1e3', '0x10', 'abc', '42 43', undefined]) expect(pidFrom(bad), String(bad)).toBeUndefined();
  });

  it('from a list, one per line: the first, or none when the list is empty (a tmux with no client attached)', () => {
    expect(firstPid('4242\n4343\n')).toBe(4242);
    expect(firstPid('')).toBeUndefined();
    expect(firstPid('\n')).toBeUndefined();
  });
});
