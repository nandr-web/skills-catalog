// A timing check that holds on a busy machine: instead of a wall-clock ceiling, it proves the work grows in step with
// its input. The full input must take under 8 times as long as a quarter of it (linear work takes 4 times, quadratic
// 16), each size timed best of 5, plus a floor for timer noise on tiny inputs. The two sizes are timed in turns (a
// quarter, then all of it, five times), so a stretch of load from other test files on the same machine slows both
// alike rather than only the size timed while it lasts. Garbage collection can still stall one measurement, so a miss is
// measured once more, and only two misses in a row fail. One generous ceiling stays as a hang guard: the full input's first run must finish within 10 s. It is
// checked when that run returns, so a run that never returns is stopped by the test's own timeout instead.

import { expect } from 'vitest';

const HANG_MS = 10_000;
const NOISE_MS = 20;

function time(run: () => unknown): number {
  const t = performance.now();
  run();
  return performance.now() - t;
}

// The best time of each size over five turns of a quarter then the whole; `full` starts from a run already timed.
function inTurns(quarter: () => unknown, whole: () => unknown, full = Infinity): { a: number; b: number } {
  let a = Infinity;
  let b = full;
  for (let i = 0; i < 5; i++) {
    a = Math.min(a, time(quarter));
    b = Math.min(b, time(whole));
  }
  return { a, b };
}

// `input(scale)` builds the input at that fraction of its full size (1 is full, 0.25 a quarter).
export function expectLinear<T>(label: string, input: (scale: number) => T, run: (x: T) => unknown): void {
  const full = input(1);
  const quarter = input(0.25);
  const first = time(() => run(full));
  expect(first, `${label}: over ${HANG_MS / 1000} s`).toBeLessThan(HANG_MS);
  let { a, b } = inTurns(() => run(quarter), () => run(full), first);
  if (b >= 8 * a + NOISE_MS) ({ a, b } = inTurns(() => run(quarter), () => run(full)));
  expect(b, `${label}: ${a.toFixed(1)} ms for a quarter of it, ${b.toFixed(1)} ms for all of it (on a second try)`).toBeLessThan(8 * a + NOISE_MS);
}

// n copies of s, at a scale (rounded, at least one).
export const times = (s: string, n: number) => (scale: number) => s.repeat(Math.max(1, Math.round(n * scale)));
