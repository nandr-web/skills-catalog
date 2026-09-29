// A timing check that holds on a busy machine: instead of a wall-clock ceiling, it proves the work grows in step with
// its input. The full input must take under 8 times as long as a quarter of it (linear work takes 4 times, quadratic
// 16), each size timed best of 3, plus a floor for timer noise on tiny inputs. Other test files running at the same
// time can still stall one measurement, so a miss is measured once more, and only two misses in a row fail. One
// generous ceiling stays as a hang guard: the full input's first run must finish within 10 s.

import { expect } from 'vitest';

const HANG_MS = 10_000;
const NOISE_MS = 20;

function time(run: () => unknown): number {
  const t = performance.now();
  run();
  return performance.now() - t;
}
const best = (run: () => unknown, first = Infinity) => Math.min(first, time(run), time(run));

// `input(scale)` builds the input at that fraction of its full size (1 is full, 0.25 a quarter).
export function expectLinear(label: string, input: (scale: number) => string, run: (s: string) => unknown): void {
  const full = input(1);
  const quarter = input(0.25);
  const first = time(() => run(full));
  expect(first, `${label}: over ${HANG_MS / 1000} s`).toBeLessThan(HANG_MS);
  let a = best(() => run(quarter), time(() => run(quarter)));
  let b = best(() => run(full), first);
  if (b >= 8 * a + NOISE_MS) {
    a = best(() => run(quarter), time(() => run(quarter)));
    b = best(() => run(full), time(() => run(full)));
  }
  expect(b, `${label}: ${a.toFixed(1)} ms for a quarter of it, ${b.toFixed(1)} ms for all of it (on a second try)`).toBeLessThan(8 * a + NOISE_MS);
}

// n copies of s, at a scale (rounded, at least one).
export const times = (s: string, n: number) => (scale: number) => s.repeat(Math.max(1, Math.round(n * scale)));
